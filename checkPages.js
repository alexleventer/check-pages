/*
 * check-pages
 * https://github.com/DavidAnson/check-pages
 *
 * Copyright (c) 2014-2016 David Anson
 * Licensed under the MIT license.
 */

'use strict';

/**
 * Checks various aspects of a web page for correctness.
 *
 * @param {object} host Specifies the environment.
 * @param {object} options Configures the task.
 * @param {function} done Callback function.
 * @returns {void}
 */
module.exports = function(host, options, done) {
  // Imports
  var cheerio = require('cheerio');
  var crchash = require('crc-hash');
  var crypto = require('crypto');
  var request = require('request');
  var requestFile = require('./requestFile.js');
  var sax = require('sax');
  var srcset = require('srcset');
  var urijs = require('urijs');
  var url = require('url');

  // Global variables
  var userAgent = 'check-pages/' + require('./package.json').version;
  var pendingCallbacks = [];
  var issues = [];
  var testedLinks = [];
  var pageCount = 0;
  var linkCount = 0;

  // Applies key/value pairs from src to dst, returning dst
  function assign(dst, src) {
    Object.keys(src).forEach(function forKey(key) {
      dst[key] = src[key];
    });
    return dst;
  }

  // Clones the key/value pairs of obj, returning the clone
  function clone(obj) {
    return assign({}, obj);
  }

  // Returns the correct plural form of a count
  function pluralize(count, word) {
    return count + ' ' + word + (count === 1 ? '' : 's');
  }

  // Returns a request object suitable for the specified URI
  function requestFor(uri) {
    if (url.parse(uri).protocol === 'file:') {
      // Custom request implementation for files
      return requestFile;
    }
    // Standard request implementation
    return request;
  }

  // Logs a message via the host
  function log(message) {
    if (!options.terse) {
      host.log(message);
    }
  }

  // Logs an error via the host
  function logError(page, message) {
    if (!options.terse) {
      host.error(message);
    }
    issues.push([page, message]);
  }

  // Returns true if and only if the specified link is on the list to ignore
  function isLinkIgnored(link) {
    return options.linksToIgnore.some(function(linkToIgnore) {
      return link.includes(linkToIgnore);
    });
  }

  // Normalizes a URI (to handle international characters and domains)
  function normalizeUri(uri) {
    var urlParse = url.parse(uri);
    if (urlParse.protocol === 'file:') {
      return uri;
    }
    var urijsParse = urijs(uri).normalize();
    var normalizedUri = urijsParse.toString();
    if ((urlParse.hash === '#') && (urijsParse.hash() === '')) {
      // Restore empty fragment removed by URI.js
      normalizedUri += '#';
    }
    return normalizedUri;
  }

  // Returns a callback to test the specified link
  function testLink(page, link, retryWithGet, trySecure) {
    return function(callback) {
      var logPageError = logError.bind(null, page);
      var parsedLink = url.parse(link);
      // Check if the link has already been tested (ignore client-side hash)
      if (!retryWithGet && !trySecure) {
        // Warn for empty fragments (even when skipping)
        if (options.noEmptyFragments && (parsedLink.hash === '#')) {
          logPageError('Empty fragment: ' + link);
        }
        parsedLink.hash = null;
        var noHashLink = url.format(parsedLink);
        if (testedLinks.indexOf(noHashLink) !== -1) {
          log('Visited link: ' + link);
          return callback();
        }
        testedLinks.push(noHashLink);
      }
      // Test the link
      var start = Date.now();
      var hash = null;
      var linkHash = null;
      if (options.queryHashes && !trySecure) {
        // Create specified hash algorithm
        var query = url.parse(link, true).query;
        if (query.sha1) {
          linkHash = query.sha1;
          hash = crypto.createHash('sha1');
        } else if (query.md5) {
          linkHash = query.md5;
          hash = crypto.createHash('md5');
        } else if (query.crc32) {
          linkHash = query.crc32;
          hash = crchash.createHash('crc32');
        }
      }
      var res = null;
      var useGetRequest = retryWithGet || options.queryHashes;
      var req = requestFor(link)(normalizeUri(link), {
        method: useGetRequest ? 'GET' : 'HEAD',
        followRedirect: !options.noRedirects
      })
        .on('error', function(err) {
          if (!trySecure) {
            logPageError('Link error (' + err.message + '): ' + link + ' (' + (Date.now() - start) + 'ms)');
          }
          req.abort();
          callback();
        })
        .on('response', function(response) {
          // Capture response object for use during 'end'
          res = response;
        })
        .on('end', function() {
          var elapsed = Date.now() - start;
          if ((200 <= res.statusCode) && (res.statusCode < 300)) {
            if (trySecure) {
              logPageError('Insecure link: ' + trySecure);
            } else {
              log('Link: ' + link + ' (' + elapsed + 'ms)');
            }
            if (hash) {
              hash.end();
              var contentHash = hash.read();
              if (linkHash.toUpperCase() === contentHash.toUpperCase()) {
                log('Hash: ' + link);
              } else {
                logPageError('Hash error (' + contentHash.toLowerCase() + '): ' + link);
              }
            }
            if (options.preferSecure && (parsedLink.protocol === 'http:')) {
              parsedLink.protocol = 'https:';
              var secureLink = url.format(parsedLink);
              testLink(page, secureLink, false, link)(callback);
              return;
            }
          } else if (useGetRequest && !trySecure) {
            if (((300 <= res.statusCode) && (res.statusCode < 400)) && options.noRedirects) {
              logPageError('Redirected link (' + res.statusCode + '): ' + link + ' -> ' + (res.headers.location || '[Missing Location header]') + ' (' + elapsed + 'ms)');
            } else {
              logPageError('Bad link (' + res.statusCode + '): ' + link + ' (' + elapsed + 'ms)');
            }
          } else {
            // Retry HEAD request as GET to be sure
            testLink(page, link, true, trySecure)(callback);
            return;
          }
          callback();
        });
      if (hash) {
        // Pipe content to hash algorithm
        hash.setEncoding('hex');
        req.pipe(hash);
      }
      if (options.noLocalLinks && !trySecure) {
        var localhost = /^(localhost)|(127\.\d\d?\d?\.\d\d?\d?\.\d\d?\d?)|(\[[0:]*:[0:]*:0?0?0?1\])$/i;
        if (req.uri && req.uri.host && localhost.test(req.uri.host)) {
          logPageError('Local link: ' + link);
        }
      }
    };
  }

  // Adds pending callbacks for all links matching <element attribute='*'/>
  function addLinks($, element, attribute, page, index) {
    var pageHostname = url.parse(page).hostname;
    $(element).each(function() {
      var value = $(this).attr(attribute);
      if (value) {
        var links = [value];
        if (attribute === 'srcset') {
          links = srcset.parse(value).map(function(size) {
            return size.url;
          });
        }
        links.forEach(function(link) {
          var resolvedLink = url.resolve(page, link);
          var parsedLink = url.parse(resolvedLink);
          if (((parsedLink.protocol === 'http:') || (parsedLink.protocol === 'https:') || (parsedLink.protocol === 'file:')) &&
              (!options.onlySameDomain || (parsedLink.hostname === pageHostname)) &&
              !isLinkIgnored(resolvedLink)) {
            // Add to beginning of queue (in order) so links gets processed before the next page
            pendingCallbacks.splice(index, 0, testLink(page, resolvedLink));
            index++;
            linkCount++;
          }
        });
      }
    });
    return index;
  }

  // Returns a callback to test the specified page
  function testPage(page) {
    pageCount++;
    return function(callback) {
      var logPageError = logError.bind(null, page);
      var start = Date.now();
      requestFor(page).get(normalizeUri(page), function(err, res, body) {
        var elapsed = Date.now() - start;
        if (err) {
          logPageError('Page error (' + err.message + '): ' + page + ' (' + elapsed + 'ms)');
        } else if ((res.statusCode < 200) || (300 <= res.statusCode)) {
          logPageError('Bad page (' + res.statusCode + '): ' + page + ' (' + elapsed + 'ms)');
        } else {
          if (page === res.request.href) {
            log('Page: ' + page + ' (' + elapsed + 'ms)');
          } else {
            log('Page: ' + page + ' -> ' + res.request.href + ' (' + elapsed + 'ms)');
            // Update page to account for redirects
            page = res.request.href;
          }
          if (options.checkLinks) {
            // Check the page's links for validity (i.e., HTTP HEAD returns OK)
            var $ = cheerio.load(body);
            var index = 0;
            ['a href', 'area href', 'audio src', 'embed src', 'iframe src', 'img src',
              'img srcset', 'input src', 'link href', 'object data', 'script src',
              'source src', 'source srcset', 'track src', 'video src', 'video poster']
              .forEach(function(pair) {
                var items = pair.split(' ');
                index = addLinks($, items[0], items[1], page, index);
              });
          }
          if (options.checkXhtml) {
            // Check the page's structure for XHTML compliance
            var parser = sax.parser(true);
            parser.onerror = function(error) {
              logPageError(error.message.replace(/\n/g, ', '));
            };
            parser.write(body);
          }
          if (options.maxResponseTime) {
            // Check the page's response time
            if (options.maxResponseTime < elapsed) {
              logPageError('Page response took more than ' + options.maxResponseTime + 'ms to complete');
            }
          }
          if (options.checkCaching) {
            // Check the page's cache headers
            var cacheControl = res.headers['cache-control'];
            if (cacheControl) {
              if (!/max-age|max-stale|min-fresh|must-revalidate|no-cache|no-store|no-transform|only-if-cached|private|proxy-revalidate|public|s-maxage/.test(cacheControl)) {
                logPageError('Invalid Cache-Control header in response: ' + cacheControl);
              }
            } else {
              logPageError('Missing Cache-Control header in response');
            }
            var etag = res.headers.etag;
            if (etag) {
              if (!/^(W\/)?"[^"]*"$/.test(etag)) {
                logPageError('Invalid ETag header in response: ' + etag);
              }
            } else if (!cacheControl || !/no-cache|max-age=0/.test(cacheControl)) { // Don't require ETag for responses that won't be cached
              logPageError('Missing ETag header in response');
            }
          }
          if (options.checkCompression) {
            // Check that the page was compressed
            var contentEncoding = res.headers['content-encoding'];
            if (contentEncoding) {
              if (!/^(deflate|gzip)$/.test(contentEncoding)) {
                logPageError('Invalid Content-Encoding header in response: ' + contentEncoding);
              }
            } else {
              logPageError('Missing Content-Encoding header in response');
            }
          }
        }
        callback();
      });
    };
  }

  // Check for required host functions
  if (!host || (typeof (host) !== 'object')) {
    throw new Error('host parameter is missing or invalid; it should be an object');
  }
  ['log', 'error'].forEach(function(name) {
    if (!host[name] || (typeof (host[name]) !== 'function')) {
      throw new Error('host.' + name + ' is missing or invalid; it should be a function');
    }
  });

  // Check for required callback
  if (!done || (typeof (done) !== 'function')) {
    throw new Error('done is missing or invalid; it should be a function');
  }

  // Check for and normalize required options
  if (!options || (typeof (options) !== 'object')) {
    throw new Error('options parameter is missing or invalid; it should be an object');
  }
  options = clone(options);
  if (!options.pageUrls || !Array.isArray(options.pageUrls)) {
    throw new Error('pageUrls option is missing or invalid; it should be an array of URLs');
  }
  options.pageUrls = options.pageUrls.map(function(pageUrl) {
    var parsed = url.parse(pageUrl);
    if (!parsed.protocol) {
      return 'file:' + pageUrl;
    }
    return pageUrl;
  });

  // Check for and normalize optional options
  options.checkLinks = !!options.checkLinks;
  options.onlySameDomain = !!options.onlySameDomain;
  options.noRedirects = !!options.noRedirects;
  options.noLocalLinks = !!options.noLocalLinks;
  options.noEmptyFragments = !!options.noEmptyFragments;
  options.queryHashes = !!options.queryHashes;
  options.preferSecure = !!options.preferSecure;
  options.linksToIgnore = options.linksToIgnore || [];
  if (!Array.isArray(options.linksToIgnore)) {
    throw new Error('linksToIgnore option is invalid; it should be an array');
  }
  options.checkXhtml = !!options.checkXhtml;
  options.checkCaching = !!options.checkCaching;
  options.checkCompression = !!options.checkCompression;
  if (options.maxResponseTime && (typeof (options.maxResponseTime) !== 'number' || (options.maxResponseTime <= 0))) {
    throw new Error('maxResponseTime option is invalid; it should be a positive number');
  }
  if (options.userAgent !== undefined) {
    if (options.userAgent) {
      if (typeof (options.userAgent) === 'string') {
        userAgent = options.userAgent;
      } else {
        throw new Error('userAgent option is invalid; it should be a string or null');
      }
    } else {
      userAgent = null;
    }
  }
  options.summary = !!options.summary;
  options.terse = !!options.terse;

  // Set request defaults
  var defaults = {
    gzip: true,
    headers: {
      // Prevent caching so response time will be accurate
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache'
    }
  };
  if (userAgent) {
    defaults.headers['User-Agent'] = userAgent;
  }
  request = request.defaults(defaults);

  // Queue callbacks for each page
  options.pageUrls.forEach(function(page) {
    pendingCallbacks.push(testPage(page));
  });

  // Queue 'done' callback
  pendingCallbacks.push(function() {
    var err = null;
    var issueCount = issues.length;
    if (options.terse) {
      host.log('Checked ' +
        pluralize(pageCount, 'page') + ' and ' +
        pluralize(linkCount, 'link') + ', found ' +
        pluralize(issueCount, 'issue') + '.');
    }
    if (issueCount) {
      if (options.summary) {
        var summary = 'Summary of issues:\n';
        var currentPage = null;
        issues.forEach(function(issue) {
          var page = issue[0];
          var message = issue[1];
          if (currentPage !== page) {
            summary += ' ' + page + '\n';
            currentPage = page;
          }
          summary += '  ' + message + '\n';
        });
        host.error(summary);
      }
      err = new Error(pluralize(issueCount, 'issue') + '.' +
        (options.summary ? '' : ' (Set options.summary for a summary.)'));
    }
    done(err, issues);
  });

  // Process the queue
  function next() {
    var callback = pendingCallbacks.shift();
    callback(next);
  }
  next();
};
