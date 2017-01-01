/* jshint node: true */

// TODO: Explore making `ClientChannel` a writable stream, and
// `ServerChannel` a readable stream. The main inconsistency is w.r.t.
// watermarks (the standard stream behavior doesn't support waiting for the
// callbacks, without also preventing concurrent requests).
// TODO: Add broadcast option to client `_emitMessage`, accessible for one-way
// messages.
// TODO: Add `server.mount` method to allow combining servers. The API is as
// follows: a mounted server's (i.e. the method's argument) handlers have lower
// precedence than the original server (i.e. `this`); the mounted server's
// middlewares are only invoked for its handlers.
// TODO: Look into channel v.s. client/server errors. It would be good to have
// a simple picture of when errors are emitted where.

'use strict';

/**
 * This module implements Avro's IPC/RPC logic.
 *
 * This is done the Node.js way, mimicking the `EventEmitter` class.
 */

var types = require('./types'),
    utils = require('./utils'),
    events = require('events'),
    stream = require('stream'),
    util = require('util');


// A few convenience imports.
var Tap = utils.Tap;
var Type = types.Type;
var debug = util.debuglog('avsc:services');
var f = util.format;

// Various useful types. We instantiate options once, to share the registry.
var OPTS = {namespace: 'org.apache.avro.ipc'};

var BOOLEAN_TYPE = Type.forSchema('boolean', OPTS);

var MAP_BYTES_TYPE = Type.forSchema({type: 'map', values: 'bytes'}, OPTS);

var STRING_TYPE = Type.forSchema('string', OPTS);

var HANDSHAKE_REQUEST_TYPE = Type.forSchema({
  name: 'HandshakeRequest',
  type: 'record',
  fields: [
    {name: 'clientHash', type: {name: 'MD5', type: 'fixed', size: 16}},
    {name: 'clientProtocol', type: ['null', 'string'], 'default': null},
    {name: 'serverHash', type: 'MD5'},
    {name: 'meta', type: ['null', MAP_BYTES_TYPE], 'default': null}
  ]
}, OPTS);

var HANDSHAKE_RESPONSE_TYPE = Type.forSchema({
  name: 'HandshakeResponse',
  type: 'record',
  fields: [
    {
      name: 'match',
      type: {
        name: 'HandshakeMatch',
        type: 'enum',
        symbols: ['BOTH', 'CLIENT', 'NONE']
      }
    },
    {name: 'serverProtocol', type: ['null', 'string'], 'default': null},
    {name: 'serverHash', type: ['null', 'MD5'], 'default': null},
    {name: 'meta', type: ['null', MAP_BYTES_TYPE], 'default': null}
  ]
}, OPTS);

// Prefix used to differentiate between messages when sharing a stream. This
// length should be smaller than 16. The remainder is used for disambiguating
// between concurrent messages (the current value, 16, therefore supports ~64k
// concurrent messages).
var PREFIX_LENGTH = 16;

// Internal message, used to check protocol compatibility.
var PING_MESSAGE = new Message(
  '',
  Type.forSchema({name: 'PingRequest', type: 'record', fields: []}, OPTS),
  Type.forSchema(['string'], OPTS),
  Type.forSchema('null', OPTS)
);

/** An Avro message, containing its request, response, etc. */
function Message(name, reqType, errType, resType, oneWay, doc) {
  this.name = name;
  if (!Type.isType(reqType, 'record')) {
    throw new Error('invalid request type');
  }
  this.requestType = reqType;
  if (
    !Type.isType(errType, 'union') ||
    !Type.isType(errType.getTypes()[0], 'string')
  ) {
    throw new Error('invalid error type');
  }
  this.errorType = errType;
  if (oneWay) {
    if (!Type.isType(resType, 'null') || errType.getTypes().length > 1) {
      throw new Error('inapplicable one-way parameter');
    }
  }
  this.responseType = resType;
  this.oneWay = !!oneWay;
  this.doc = doc !== undefined ? '' + doc : undefined;
}

Message.forSchema = function (name, schema, opts) {
  opts = opts || {};
  if (!types.isValidName(name)) {
    throw new Error(f('invalid message name: %s', name));
  }
  // We use a record with a placeholder name here (the user might have set
  // `noAnonymousTypes`, so we can't use an anonymous one). We remove it from
  // the registry afterwards to avoid exposing it outside.
  if (!Array.isArray(schema.request)) {
    throw new Error(f('invalid message request: %s', name));
  }
  var recordName = f('%s.%sRequest', OPTS.namespace, utils.capitalize(name));
  var reqType = Type.forSchema({
    name: recordName,
    type: 'record',
    namespace: opts.namespace || '', // Don't leak request namespace.
    fields: schema.request
  }, opts);
  delete opts.registry[recordName];
  if (!schema.response) {
    throw new Error(f('invalid message response: %s', name));
  }
  var resType = Type.forSchema(schema.response, opts);
  if (schema.errors !== undefined && !Array.isArray(schema.errors)) {
    throw new Error(f('invalid message errors: %s', name));
  }
  var errType = Type.forSchema(['string'].concat(schema.errors || []), opts);
  var oneWay = !!schema['one-way'];
  return new Message(name, reqType, errType, resType, oneWay, schema.doc);
};

Message.prototype.schema = Type.prototype.getSchema;

Message.prototype._attrs = function (opts) {
  var reqSchema = this.requestType._attrs(opts);
  var schema = {
    request: reqSchema.fields,
    response: this.responseType._attrs(opts)
  };
  var msgDoc = this.doc;
  if (msgDoc !== undefined) {
    schema.doc = msgDoc;
  }
  var errSchema = this.errorType._attrs(opts);
  if (errSchema.length > 1) {
    schema.errors = errSchema.slice(1);
  }
  if (this.oneWay) {
    schema['one-way'] = true;
  }
  return schema;
};

// Deprecated.

utils.addDeprecatedGetters(
  Message,
  ['name', 'errorType', 'requestType', 'responseType']
);

Message.prototype.isOneWay = util.deprecate(
  function () { return this.oneWay; },
  'use `.oneWay` directly instead of `.isOneWay()`'
);

/**
 * An Avro RPC service.
 *
 * This constructor shouldn't be called directly, but via the
 * `Service.forProtocol` method. This function performs little logic to better
 * support efficient copy.
 */
function Service(name, messages, types, ptcl, server) {
  if (typeof name != 'string') {
    // Let's be helpful in case this class is instantiated directly.
    return Service.forProtocol(name, messages);
  }

  this.name = name;
  this._messagesByName = messages || {};
  this.messages = utils.objectValues(this._messagesByName);

  this._typesByName = types || {};
  this.types = utils.objectValues(this._typesByName);

  this.protocol = ptcl;
  // We cache a string rather than a buffer to not retain an entire slab.
  this._hashStr = utils.getHash(JSON.stringify(ptcl)).toString('binary');
  this.doc = ptcl.doc ? '' + ptcl.doc : undefined;

  // We add a server to each protocol for backwards-compatibility (to allow the
  // use of `protocol.on`). This covers all cases except the use of the
  // `strictErrors` option, which requires moving to the new API.
  this._server = server || this.createServer({silent: true});
}

Service.forProtocol = function (ptcl, opts) {
  opts = opts || {};

  var name = ptcl.protocol;
  if (!name) {
    throw new Error('missing protocol name');
  }
  if (ptcl.namespace !== undefined) {
    opts.namespace = ptcl.namespace;
  } else {
    var match = /^(.*)\.[^.]+$/.exec(name);
    if (match) {
      opts.namespace = match[1];
    }
  }
  name = types.qualify(name, opts.namespace);

  if (ptcl.types) {
    ptcl.types.forEach(function (obj) { Type.forSchema(obj, opts); });
  }
  var msgs;
  if (ptcl.messages) {
    msgs = {};
    Object.keys(ptcl.messages).forEach(function (key) {
      msgs[key] = Message.forSchema(key, ptcl.messages[key], opts);
    });
  }

  return new Service(name, msgs, opts.registry, ptcl);
};

Service.isService = function (any) {
  // Not fool-proof but likely sufficient.
  return !!any && any.hasOwnProperty('_hashStr');
};

Service.prototype.createClient = function (opts) {
  var client = new Client(this, opts);
  process.nextTick(function () {
    // We delay this processing such that we can attach handlers to the client
    // before any channels get created.
    if (opts && opts.server) {
      // Convenience in-memory client. This can be useful to make requests
      // relatively efficiently to an in-process server. Note that it is still
      // is less efficient than direct method calls (because of the
      // serialization, which does provide "type-safety" though).
      var obj = {objectMode: true};
      var pts = [new stream.PassThrough(obj), new stream.PassThrough(obj)];
      opts.server.createChannel({readable: pts[0], writable: pts[1]}, obj);
      client.createChannel({readable: pts[1], writable: pts[0]}, obj);
    } else if (opts && opts.transport) {
      // Convenience functionality for the common single channel use-case: we
      // add a single channel using default options to the client.
      client.createChannel(opts.transport);
    }
  });
  return client;
};

Service.prototype.createServer = function (opts) {
  return new Server(this, opts);
};

Object.defineProperty(Service.prototype, 'hash', {
  enumerable: true,
  get: function () { return new Buffer(this._hashStr, 'binary'); }
});

Service.prototype.message = function (name) {
  return this._messagesByName[name];
};

Service.prototype.type = function (name) {
  return this._typesByName[name];
};

Service.prototype.inspect = function () {
  return f('<Service %j>', this.name);
};

// Deprecated methods.

utils.addDeprecatedGetters(
  Service,
  ['message', 'messages', 'name', 'type', 'types']
);

Service.prototype.createEmitter = util.deprecate(
  function (transport, opts) {
    opts = opts || {};
    var client = this.createClient({
      cache: opts.cache,
      noBuffering: true,
      strictErrors: opts.strictErrors,
      timeout: opts.timeout
    });
    var channel = client.createChannel(transport, opts);
    client.on('error', function (err) { channel.emit('error', err); });
    return channel;
  },
  'use `.createClient()` instead of `.createEmitter()`'
);

Service.prototype.createListener = util.deprecate(
  function (transport, opts) {
    if (opts && opts.strictErrors) {
      throw new Error('use `.createServer()` to support strict errors');
    }
    return this._server.createChannel(transport, opts);
  },
  'use `.createServer().createChannel()` instead of `.createListener()`'
);

Service.prototype.emit = util.deprecate(
  function (name, req, channel, cb) {
    if (!channel || !this.equals(channel.client._svc$)) {
      throw new Error('invalid emitter');
    }

    var client = channel.client;
    // In case the method is overridden.
    Client.prototype.emitMessage.call(client, name, req, cb && cb.bind(this));
    return channel.getPending();
  },
  'create a client via `.createClient()` to emit messages instead of `.emit()`'
);

Service.prototype.equals = util.deprecate(
  function (any) {
    return (
      Service.isService(any) &&
      this.getFingerprint().equals(any.getFingerprint())
    );
  },
  'equality testing is deprecated, compare the `.protocol`s instead'
);

Service.prototype.getFingerprint = util.deprecate(
  function (algorithm) {
    return utils.getHash(JSON.stringify(this.protocol), algorithm);
  },
  'use `.hash` instead of `.getFingerprint()`'
);

Service.prototype.getSchema = util.deprecate(
  Type.prototype.getSchema,
  'use `.protocol` instead of `.getSchema()`'
);

Service.prototype.on = util.deprecate(
  function (name, handler) {
    var self = this; // This protocol.
    this._server.onMessage(name, function (req, cb) {
      return handler.call(self, req, this.channel, cb);
    });
    return this;
  },
  'use `.createServer().onMessage()` instead of `.on()`'
);

Service.prototype.subprotocol = util.deprecate(
  function () {
    var parent = this._server;
    var opts = {strictErrors: parent._strict, cache: parent._cache};
    var server = new Server(parent.service, opts);
    server._handlers = Object.create(parent._handlers);
    return new Service(
      this.name,
      this._messagesByName,
      this._typesByName,
      this.protocol,
      server
    );
  },
  '`.subprotocol()` will be removed in 5.1'
);

Service.prototype._attrs = function (opts) {
  var ptcl = {protocol: this.name};

  var types = [];
  this.types.forEach(function (t) {
    if (t.getName() === undefined) {
      // Don't include any unnamed types (e.g. primitives).
      return;
    }
    var typeSchema = t._attrs(opts);
    if (typeof typeSchema != 'string') {
      // Some of the named types might already have been defined in a
      // previous type, in this case we don't include its reference.
      types.push(typeSchema);
    }
  });
  if (types.length) {
    ptcl.types = types;
  }

  var msgNames = Object.keys(this._messagesByName);
  if (msgNames.length) {
    ptcl.messages = {};
    msgNames.forEach(function (name) {
      ptcl.messages[name] = this._messagesByName[name]._attrs(opts);
    }, this);
  }

  if (opts && opts.exportAttrs && this.doc !== undefined) {
    ptcl.doc = this.doc;
  }
  return ptcl;
};

/** Function to retrieve a remote service's protocol. */
function discoverProtocol(transport, opts, cb) {
  if (cb === undefined && typeof opts == 'function') {
    cb = opts;
    opts = undefined;
  }

  var svc = new Service({protocol: 'Empty'}, OPTS);
  svc.createClient({timeout: opts && opts.timeout})
    .createChannel(transport, {
      scope: opts && opts.scope,
      endWritable: typeof transport == 'function' // Stateless transports only.
    }).once('handshake', function (hreq, hres) {
        this.destroy(true); // Prevent further requests on this channel.
        cb(null, JSON.parse(hres.serverProtocol));
      })
      .once('error', function (err) {
        // Stateless transports will throw an interrupted error when the
        // channel is destroyed, we ignore it here.
        this.destroy(true);
        if (!/interrupted/.test(err)) {
          cb(err); // Likely timeout.
        }
      });
}

/** Load-balanced message sender. */
function Client(svc, opts) {
  opts = opts || {};
  events.EventEmitter.call(this);

  // We have to suffix all client properties to be safe, since the message
  // names aren't prefixed with clients (unlike servers).
  this._svc$ = svc;
  this._channels$ = []; // Active channels.
  this._fns$ = []; // Middleware functions.

  this._buffering$ = !opts.noBuffering;
  this._cache$ = opts.cache || {}; // For backwards compatibility.
  this._policy$ = opts.channelPolicy;
  this._strict$ = !!opts.strictErrors;
  this._timeout$ = utils.getOption(opts, 'timeout', 10000);

  if (opts.remoteProtocols) {
    Adapter._populateCache(this._cache$, svc, opts.remoteProtocols, true);
  }

  this._svc$.messages.forEach(function (msg) {
    this[msg.name] = this._createMessageHandler(msg);
  }, this);
}
util.inherits(Client, events.EventEmitter);

Client.prototype.activeChannels = function () {
  return this._channels$.slice();
};

Client.prototype.createChannel = function (transport, opts) {
  var objectMode = opts && opts.objectMode;
  var channel;
  if (typeof transport == 'function') {
    var writableFactory;
    if (objectMode) {
      writableFactory = transport;
    } else {
      // We provide a default standard-compliant codec. This should support
      // most use-cases (for example when speaking to the official Java and
      // Python implementations over HTTP, or when this library is used for
      // both the emitting and listening sides).
      writableFactory = function (cb) {
        var encoder = new FrameEncoder();
        encoder.pipe(transport(function (err, readable) {
          if (err) {
            cb(err);
            return;
          }
          // Since the decoder isn't exposed (so can't have an error handler
          // attached, we forward any errors to the client). This will only
          // happen when the readable stream is interrupted mid-response.
          var decoder = new FrameDecoder()
            .on('error', function (err) { channel.emit('error', err, this); });
          cb(null, readable.pipe(decoder));
        }));
        return encoder;
      };
    }
    channel = new StatelessClientChannel(this, writableFactory, opts);
  } else {
    var readable, writable;
    if (isStream(transport)) {
      readable = writable = transport;
    } else {
      readable = transport.readable;
      writable = transport.writable;
    }
    if (!objectMode) {
      // To ease communication with Java servers, we provide a default codec
      // compatible with Java servers' `NettyTransportCodec`'s implementation.
      // Similar to above, we also forward any errors to the client.
      var decoder = new NettyDecoder()
        .on('error', function (err) { channel.emit('error', err, this); });
      readable = readable.pipe(decoder);
      var encoder = new NettyEncoder();
      encoder.pipe(writable);
      writable = encoder;
    }
    channel = new StatefulClientChannel(this, readable, writable, opts);
    if (!objectMode) {
      // Since we never expose the encoder and decoder, we must release them
      // ourselves here.
      channel.once('eot', function () {
        readable.unpipe(decoder);
        encoder.unpipe(writable);
      });
    }
  }
  var channels = this._channels$;
  channels.push(channel);
  channel.once('_drain', function () {
    // Remove the channel from the list of active ones.
    channels.splice(channels.indexOf(this), 1);
  });
  this.emit('channel', channel);
  return channel;
};

Client.prototype.destroyChannels = function (opts) {
  this._channels$.forEach(function (channel) {
    channel.destroy(opts && opts.noWait);
  });
};

Client.prototype.emitMessage = function (name, req, opts, cb) {
  if (!cb && typeof opts === 'function') {
    cb = opts;
    opts = undefined;
  }
  var msg = getExistingMessage(this._svc$, name);
  var wreq = new WrappedRequest(msg, {}, req);
  return Client.prototype._emitMessage.call(this, wreq, opts, cb);
};

Client.prototype.remoteProtocols = function () {
  return Adapter._getRemoteProtocols(this._svc$, this._cache$, true);
};

Object.defineProperty(Client.prototype, 'service', {
  enumerable: true,
  get: function () { return this._svc$; }
});

Client.prototype.use = function (/* fn ... */) {
  var i, l, fn;
  for (i = 0, l = arguments.length; i < l; i++) {
    fn = arguments[i];
    this._fns$.push(fn.length < 3 ? fn(this) : fn);
  }
  return this;
};

Client.prototype._emitMessage = function (wreq, opts, cb) {
  // Common logic between `client.emitMessage` and the "named" message methods.
  var self = this;
  var channels = this._channels$;
  var numChannels = channels.length;
  if (!numChannels) {
    if (this._buffering$) {
      debug('no active client channels, buffering call');
      this.once('channel', function () {
        this._emitMessage(wreq, opts, cb);
      });
    } else {
      var err = new Error('no active channels');
      process.nextTick(function () {
        if (cb) {
          cb.call(new CallContext(wreq._msg), err);
        } else {
          self.emit('error', err);
        }
      });
    }
    return;
  }

  opts = opts || {};
  if (opts.timeout === undefined) {
    opts.timeout = this._timeout$;
  }

  var channel;
  if (numChannels === 1) {
    // Common case, optimized away.
    channel = channels[0];
  } else if (this._policy$) {
    channel = this._policy$(this._channels$.slice());
  } else {
    // Random selection, cheap and likely good enough for most use-cases.
    channel = channels[Math.floor(Math.random() * numChannels)];
  }

  channel._emit(wreq, opts, function (err, wres) {
    var ctx = this; // Call context.
    var errType = ctx.message.errorType;
    if (err) {
      // System error, likely the message wasn't sent (or an error occurred
      // while decoding the response).
      if (self._strict$) {
        var errStr = err.stack || /* istanbul ignore next */ err.toString();
        err = errType.clone(errStr, {wrapUnions: true});
      }
      done(err);
      return;
    }
    if (!wres) {
      // This is a one way message.
      done();
      return;
    }
    // Message transmission succeeded, we transmit the message data; massaging
    // any error strings into actual `Error` objects in non-strict mode.
    err = wres.error;
    if (!self._strict$) {
      // Try to coerce an eventual error into more idiomatic JavaScript types:
      // `undefined` becomes `null` and a remote string "system" error is
      // wrapped inside an actual `Error` object.
      if (err === undefined) {
        err = null;
      } else {
        if (Type.isType(errType, 'union:unwrapped')) {
          if (typeof err == 'string') {
            err = new Error(err);
          }
        } else if (err && err.string && typeof err.string == 'string') {
          err = new Error(err.string);
        }
      }
    }
    done(err, wres.response);

    function done(err, res) {
      if (cb) {
        cb.call(ctx, err, res);
      } else if (err) {
        channel.emit('error', err);
      }
    }
  });
};

Client.prototype._createMessageHandler = function (msg) {
  // jshint -W054
  var fields = msg.requestType.getFields();
  var names = fields.map(function (f) { return f.getName(); });
  var body = 'return function ' + msg.name + '(';
  if (names.length) {
    body += names.join(', ') + ', ';
  }
  body += 'opts, cb) {\n';
  body += '  if (!cb && typeof opts == \'function\') {\n';
  body += '    cb = opts;\n';
  body += '    opts = undefined;\n';
  body += '  }\n';
  body += '  var req = {\n    ';
  body += names.map(function (n) { return n + ': ' + n; }).join(',\n    ');
  body += '\n  };\n';
  body += '  var wreq = new WrappedRequest(msg, {}, req);\n';
  body += '  return emit.call(this, wreq, opts, cb);\n';
  body += '};';
  var fn = new Function('WrappedRequest,msg,emit', body);
  return fn(WrappedRequest, msg, Client.prototype._emitMessage);
};

/** Message receiver. */
function Server(svc, opts) {
  opts = opts || {};
  events.EventEmitter.call(this);

  this.service = svc;
  this._handlers = {};
  this._fns = []; // Middleware functions.
  this._channels = {}; // Active channels.
  this._nextChannelId = 1;

  this._cache = opts.cache || {}; // Deprecated.
  this._defaultHandler = opts.defaultHandler;
  this._sysErrFormatter = opts.systemErrorFormatter;
  this._silent = !!opts.silent;
  this._strict = !!opts.strictErrors;

  if (opts.remoteProtocols) {
    Adapter._populateCache(this._cache, svc, opts.remoteProtocols, false);
  }

  svc.messages.forEach(function (msg) {
    var name = msg.name;
    if (!opts.noCapitalize) {
      name = utils.capitalize(name);
    }
    this['on' + name] = this._createMessageHandler(msg);
  }, this);
}
util.inherits(Server, events.EventEmitter);

Server.prototype.activeChannels = function () {
  return utils.objectValues(this._channels);
};

Server.prototype.createChannel = function (transport, opts) {
  var objectMode = opts && opts.objectMode;
  var channel;
  if (typeof transport == 'function') {
    var readableFactory;
    if (objectMode) {
      readableFactory = transport;
    } else {
      readableFactory = function (cb) {
        var decoder = new FrameDecoder()
          .on('error', function (err) { channel.emit('error', err, this); });
        return transport(function (err, writable) {
          if (err) {
            cb(err);
            return;
          }
          var encoder = new FrameEncoder();
          encoder.pipe(writable);
          cb(null, encoder);
        }).pipe(decoder);
      };
    }
    channel = new StatelessServerChannel(this, readableFactory, opts);
  } else {
    var readable, writable;
    if (isStream(transport)) {
      readable = writable = transport;
    } else {
      readable = transport.readable;
      writable = transport.writable;
    }
    if (!objectMode) {
      var decoder = new NettyDecoder()
        .on('error', function (err) { channel.emit('error', err, this); });
      readable = readable.pipe(decoder);
      var encoder = new NettyEncoder();
      encoder.pipe(writable);
      writable = encoder;
    }
    channel = new StatefulServerChannel(this, readable, writable, opts);
    if (!objectMode) {
      // Similar to client channels, since we never expose the encoder and
      // decoder, we must release them ourselves here.
      channel.once('eot', function () {
        readable.unpipe(decoder);
        encoder.unpipe(writable);
      });
    }
  }

  if (!this.listeners('error').length) {
    this.on('error', this._onError);
  }
  var channelId = this._nextChannelId++;
  var channels = this._channels;
  channels[channelId] = channel
    .once('eot', function () { delete channels[channelId]; });
  this.emit('channel', channel);
  return channel;
};

Server.prototype.onMessage = function (name, handler) {
  getExistingMessage(this.service, name); // Check message existence.
  this._handlers[name] = handler;
  return this;
};

Server.prototype.remoteProtocols = function () {
  return Adapter._getRemoteProtocols(this._svc, this._cache, false);
};

Server.prototype.use = function (/* fn ... */) {
  var i, l, fn;
  for (i = 0, l = arguments.length; i < l; i++) {
    fn = arguments[i];
    this._fns.push(fn.length < 3 ? fn(this) : fn);
  }
  return this;
};

Server.prototype._createMessageHandler = function (msg) {
  // jshint -W054
  var body = 'return function (handler) {\n';
  body += '  return server.onMessage(\'' + msg.name + '\', ';
  body += 'function (req, cb) {\n';
  body += '    handler.call(this';
  var fields = msg.requestType.getFields();
  if (fields.length) {
    var args = fields.map(function (f) { return 'req.' + f.getName(); });
    body += ', ' + args.join(', ');
  }
  body += ', cb);\n';
  body += '  });\n';
  body += '};\n';
  return (new Function('server', body))(this);
};

Server.prototype._onError = function (err) {
  /* istanbul ignore if */
  if (!this._silent && err.rpcCode !== 'UNKNOWN_PROTOCOL') {
    console.error();
    console.error(err.rpcCode || 'INTERNAL_SERVER_ERROR');
    console.error(err.stack || err.toString());
  }
};

/** Base message emitter class. See below for the two available variants. */
function ClientChannel(client, opts) {
  opts = opts || {};
  events.EventEmitter.call(this);

  this.client = client;
  this.timeout = utils.getOption(opts, 'timeout', client._timeout$);
  this._endWritable = !!utils.getOption(opts, 'endWritable', true);
  this._prefix = normalizedPrefix(opts.scope);

  var cache = client._cache$;
  var clientSvc = client._svc$;
  var hash = opts.serverHash;
  if (!hash) {
    hash = clientSvc.hash;
  }
  var adapter = cache[hash];
  if (!adapter) {
    // This might happen even if the server hash option was set if the cache
    // doesn't contain the corresponding adapter. In this case we fall back to
    // the client's protocol (as mandated by the spec).
    hash = clientSvc.hash;
    adapter = cache[hash] = new Adapter(clientSvc, clientSvc, hash);
  }
  this._adapter = adapter;

  this._registry = new Registry(this, PREFIX_LENGTH);
  this.pending = 0;
  this.destroyed = false;
  this.draining = false;
  this.once('_eot', function (pending) {
    debug('client channel EOT');
    this.destroyed = true;
    this.emit('eot', pending);
  });
}
util.inherits(ClientChannel, events.EventEmitter);

ClientChannel.prototype.destroy = function (noWait) {
  debug('destroying client channel');
  if (!this.draining) {
    this.draining = true;
    this.emit('_drain');
  }
  var registry = this._registry;
  var pending = this.pending;
  if (noWait) {
    registry.clear();
  }
  if (noWait || !pending) {
    this.emit('_eot', pending);
  } else {
    debug('client channel entering drain mode (%s pending)', pending);
  }
};

ClientChannel.prototype.ping = function (timeout, cb) {
  if (!cb && typeof timeout == 'function') {
    cb = timeout;
    timeout = undefined;
  }
  var self = this;
  var wreq = new WrappedRequest(PING_MESSAGE);
  this._emit(wreq, {timeout: timeout}, function (err) {
    if (cb) {
      cb.call(self, err);
    } else if (err) {
      self.emit('error', err);
    }
  });
};

ClientChannel.prototype._createHandshakeRequest = function (adapter, noSvc) {
  var svc = this.client._svc$;
  return {
    clientHash: svc.hash,
    clientProtocol: noSvc ? null : JSON.stringify(svc.protocol),
    serverHash: adapter._hash
  };
};

ClientChannel.prototype._emit = function (wreq, opts, cb) {
  var msg = wreq._msg;
  var wres = msg.oneWay ? undefined : new WrappedResponse({});
  var ctx = new CallContext(msg, this);
  var self = this;
  this.pending++;
  process.nextTick(function () {
    if (!msg.name) {
      // Ping request, bypass middleware.
      onTransition(wreq, wres, onCompletion);
    } else {
      self.emit('outgoingCall', ctx, opts);
      var fns = self.client._fns$;
      debug('starting client middleware chain (%s middleware)', fns.length);
      chainMiddleware({
        fns: fns,
        ctx: ctx,
        wreq: wreq,
        wres: wres,
        onTransition: onTransition,
        onCompletion: onCompletion,
        onError: onError
      });
    }
  });
  return this.pending;

  function onTransition(wreq, wres, prev) {
    // Serialize the message.
    var err, reqBuf;
    if (self.destroyed) {
      err = new Error('destroyed');
    } else {
      try {
        reqBuf = wreq.toBuffer();
      } catch (cause) {
        err = serializationError(
          f('invalid %s request', msg.name),
          'req',
          wreq.request,
          msg.requestType
        );
      }
    }
    if (err) {
      prev(err);
      return;
    }

    // Generate the response callback.
    var timeout = (opts && opts.timeout !== undefined) ?
      opts.timeout :
      self.timeout;
    var id = self._registry.add(timeout, function (err, resBuf, adapter) {
      if (!err && !msg.oneWay) {
        try {
          adapter._decodeResponse(resBuf, wres, msg);
        } catch (cause) {
          err = toRpcError('INVALID_RESPONSE', cause);
        }
      }
      prev(err);
    });
    id |= self._prefix;

    debug('sending message %s', id);
    self._send(id, reqBuf, !!msg && msg.oneWay);
  }

  function onCompletion(err) {
    self.pending--;
    cb.call(ctx, err, wres);
    if (self.draining && !self.destroyed && !self.pending) {
      self.destroy();
    }
  }

  function onError(err) {
    self.emit('error', err);
  }
};

ClientChannel.prototype._getAdapter = function (hres) {
  var hash = hres.serverHash;
  var cache = this.client._cache$;
  var adapter = cache[hash];
  if (adapter) {
    return adapter;
  }
  var ptcl = JSON.parse(hres.serverProtocol);
  // Wrapping is required to support all schemas, but has no effect on the
  // final output (controlled by the server's protocol) since resolution is
  // independent of whether unions are wrapped or not.
  var serverSvc = Service.forProtocol(ptcl, {wrapUnions: true});
  adapter = new Adapter(this.client._svc$, serverSvc, hash, true);
  return cache[hash] = adapter;
};

ClientChannel.prototype._matchesPrefix = function (id) {
  return matchesPrefix(id, this._prefix);
};

ClientChannel.prototype._send = utils.abstractFunction;

// Deprecated.

utils.addDeprecatedGetters(ClientChannel, ['pending', 'timeout']);

ClientChannel.prototype.getCache = util.deprecate(
  function () { return this.client._cache$; },
  'use `.remoteProtocols()` instead of `.getCache()`'
);

ClientChannel.prototype.getProtocol = util.deprecate(
  function () {
    return this.client._svc$;
  },
  'use `.service` instead or `.getProtocol()`'
);

ClientChannel.prototype.isDestroyed = util.deprecate(
  function () { return this.destroyed; },
  'use `.destroyed` instead of `.isDestroyed`'
);

/**
 * Factory-based client channel.
 *
 * This channel doesn't keep a persistent connection to the server and requires
 * prepending a handshake to each message emitted. Usage examples include
 * talking to an HTTP server (where the factory returns an HTTP request).
 *
 * Since each message will use its own writable/readable stream pair, the
 * advantage of this channel is that it is able to keep track of which response
 * corresponds to each request without relying on transport ordering. In
 * particular, this means these channels are compatible with any server
 * implementation.
 */
function StatelessClientChannel(client, writableFactory, opts) {
  ClientChannel.call(this, client, opts);
  this._writableFactory = writableFactory;

  if (!opts || !opts.noPing) {
    // Ping the server to check whether the remote protocol is compatible.
    // If not, this will throw an error on the channel.
    debug('emitting ping request');
    this.ping();
  }
}
util.inherits(StatelessClientChannel, ClientChannel);

StatelessClientChannel.prototype._send = function (id, reqBuf) {
  var cb = this._registry.get(id);
  var adapter = this._adapter;
  var self = this;
  process.nextTick(emit);
  return true;

  function emit(retry) {
    if (self.destroyed) {
      // The request's callback will already have been called.
      return;
    }

    var hreq = self._createHandshakeRequest(adapter, !retry);

    var writable = self._writableFactory.call(self, function (err, readable) {
      if (err) {
        cb(err);
        return;
      }
      readable.on('data', function (obj) {
        debug('received response %s', obj.id);
        // We don't check that the prefix matches since the ID likely hasn't
        // been propagated to the response (see default stateless codec).
        var buf = Buffer.concat(obj.payload);
        try {
          var parts = readHead(HANDSHAKE_RESPONSE_TYPE, buf);
          var hres = parts.head;
          if (hres.serverHash) {
            adapter = self._getAdapter(hres);
          }
        } catch (cause) {
          cb(toRpcError('INVALID_HANDSHAKE_RESPONSE', cause));
          return;
        }
        debug('handshake match: %s', hres.match);
        self.emit('handshake', hreq, hres);
        if (hres.match === 'NONE') {
          process.nextTick(function() { emit(true); });
          return;
        }
        // Change the default adapter.
        self._adapter = adapter;
        cb(null, parts.tail, adapter);
      });
    });

    writable.write({
      id: id,
      payload: [HANDSHAKE_REQUEST_TYPE.toBuffer(hreq), reqBuf]
    });
    if (self._endWritable) {
      writable.end();
    }
  }
};

/**
 * Multiplexing client channel.
 *
 * These channels reuse the same streams (both readable and writable) for all
 * messages. This avoids a lot of overhead (e.g. creating new connections,
 * re-issuing handshakes) but requires the underlying transport to support
 * forwarding message IDs.
 */
function StatefulClientChannel(client, readable, writable, opts) {
  ClientChannel.call(this, client, opts);
  this._readable = readable;
  this._writable = writable;
  this._connected = !!(opts && opts.noPing);
  this._readable.on('end', onEnd);
  this._writable.on('finish', onFinish);

  var timer = null;
  this.once('eot', function () {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    // Remove references to this channel to avoid potential memory leaks.
    this._writable.removeListener('finish', onFinish);
    if (this._endWritable) {
      debug('ending transport');
      this._writable.end();
    }
    this._readable
      .removeListener('data', onPing)
      .removeListener('data', onMessage)
      .removeListener('end', onEnd);
  });

  var self = this;
  var hreq; // For handshake events.
  if (this._connected) {
    this._readable.on('data', onMessage);
  } else {
    this._readable.on('data', onPing);
    process.nextTick(ping);
    if (self.timeout) {
      timer = setTimeout(function () {
        self.destroy(true);
        self.emit('error', new Error('connection timeout'));
      }, self.timeout);
    }
  }

  function ping(retry) {
    if (self.draining) {
      return;
    }
    hreq = self._createHandshakeRequest(self._adapter, !retry);
    var payload = [
      HANDSHAKE_REQUEST_TYPE.toBuffer(hreq),
      new Buffer([0, 0]) // No header, no data (empty message name).
    ];
    // We can use a static ID here since we are guaranteed that this message is
    // the only one on the channel (for this scope at least).
    self._writable.write({id: self._prefix, payload: payload});
  }

  function onPing(obj) {
    if (!self._matchesPrefix(obj.id)) {
      debug('discarding unscoped response %s (still connecting)', obj.id);
      return;
    }
    var buf = Buffer.concat(obj.payload);
    try {
      var hres = readHead(HANDSHAKE_RESPONSE_TYPE, buf).head;
      if (hres.serverHash) {
        self._adapter = self._getAdapter(hres);
      }
    } catch (cause) {
      self.destroy(true); // Not a recoverable error.
      var err = toRpcError('INVALID_HANDSHAKE_RESPONSE', cause);
      self.client.emit('error', err);
      return;
    }
    debug('handshake match: %s', hres.match);
    self.emit('handshake', hreq, hres);
    if (hres.match === 'NONE') {
      process.nextTick(function () { ping(true); });
    } else {
      debug('successfully connected');
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      self._readable.removeListener('data', onPing).on('data', onMessage);
      self._connected = true;
      self.emit('_connected');
      hreq = null; // Release reference.
    }
  }

  // Callback used after a connection has been established.
  function onMessage(obj) {
    var id = obj.id;
    if (!self._matchesPrefix(id)) {
      debug('discarding unscoped message %s', id);
      return;
    }
    var cb = self._registry.get(id);
    if (cb) {
      process.nextTick(function () {
        debug('received message %s', id);
        // Ensure that the initial callback gets called asynchronously, even
        // for completely synchronous transports (otherwise the number of
        // pending requests will sometimes be inconsistent between stateful and
        // stateless transports).
        cb(null, Buffer.concat(obj.payload), self._adapter);
      });
    }
  }

  function onEnd() { self.destroy(true); }
  function onFinish() { self.destroy(); }
}
util.inherits(StatefulClientChannel, ClientChannel);

StatefulClientChannel.prototype._send = function (id, reqBuf, oneWay) {
  if (!this._connected) {
    debug('queuing request %s', id);
    this.once('_connected', function () { this._send(id, reqBuf, oneWay); });
    return false; // Call is being buffered.
  }
  if (oneWay) {
    var self = this;
    // Clear the callback, passing in an empty header.
    process.nextTick(function () {
      self._registry.get(id)(null, new Buffer([0, 0, 0]), self._adapter);
    });
  }
  return this._writable.write({id: id, payload: [reqBuf]});
};

/** The server-side emitter equivalent. */
function ServerChannel(server, opts) {
  opts = opts || {};
  events.EventEmitter.call(this);

  this.server = server;
  this._endWritable = !!utils.getOption(opts, 'endWritable', true);
  this._prefix = normalizedPrefix(opts.scope);

  var cache = server._cache;
  var svc = server.service;
  var hash = svc.hash;
  if (!cache[hash]) {
    // Add the channel's protocol to the cache if it isn't already there. This
    // will save a handshake the first time on channels with the same protocol.
    cache[hash] = new Adapter(svc, svc, hash);
  }
  this._adapter = null;

  this.destroyed = false;
  this.draining = false;
  this.pending = 0;
  this.once('_eot', function (pending) {
    var self = this;
    process.nextTick(function () {
      debug('server channel EOT');
      self.emit('eot', pending);
    });
  });
}
util.inherits(ServerChannel, events.EventEmitter);

ServerChannel.prototype.destroy = function (noWait) {
  if (!this.draining) {
    this.draining = true;
    this.emit('_drain');
  }
  if (noWait || !this.pending) {
    this.destroyed = true;
    this.emit('_eot', this.pending);
  }
};

ServerChannel.prototype._createHandshakeResponse = function (err, hreq) {
  var svc = this.server.service;
  var buf = svc.hash;
  var serverMatch = hreq && hreq.serverHash.equals(buf);
  return {
    match: err ? 'NONE' : (serverMatch ? 'BOTH' : 'CLIENT'),
    serverProtocol: serverMatch ? null : JSON.stringify(svc.protocol),
    serverHash: serverMatch ? null : buf
  };
};

ServerChannel.prototype._getAdapter = function (hreq) {
  var hash = hreq.clientHash;
  var adapter = this.server._cache[hash];
  if (adapter) {
    return adapter;
  }
  if (!hreq.clientProtocol) {
    throw toRpcError('UNKNOWN_PROTOCOL');
  }
  var ptcl = JSON.parse(hreq.clientProtocol);
  // See `ClientChannel._getAdapter` for `wrapUnions` motivation.
  var clientSvc = Service.forProtocol(ptcl, {wrapUnions: true});
  adapter = new Adapter(clientSvc, this.server.service, hash, true);
  return this.server._cache[hash] = adapter;
};

ServerChannel.prototype._matchesPrefix = function (id) {
  return matchesPrefix(id, this._prefix);
};

ServerChannel.prototype._receive = function (reqBuf, adapter, cb) {
  var self = this;
  var wreq;
  try {
    wreq = adapter._decodeRequest(reqBuf);
  } catch (cause) {
    cb(self._encodeSystemError(toRpcError('INVALID_REQUEST', cause)));
    return;
  }

  var msg = wreq._msg;
  var wres = msg.oneWay ? undefined : new WrappedResponse({});
  if (!msg.name) {
    // Ping message, we don't invoke middleware logic in this case.
    wres.response = null;
    cb(wres.toBuffer(msg), false);
    return;
  }

  var ctx = new CallContext(msg, this);
  self.emit('incomingCall', ctx);
  var fns = this.server._fns;
  debug('starting server middleware chain (%s middleware)', fns.length);
  self.pending++;
  chainMiddleware({
    fns: fns,
    ctx: ctx,
    wreq: wreq,
    wres: wres,
    onTransition: onTransition,
    onCompletion: onCompletion,
    onError: onError
  });

  function onTransition(wreq, wres, prev) {
    var handler = self.server._handlers[msg.name];
    if (!handler) {
      // The underlying service hasn't implemented a handler.
      var defaultHandler = self.server._defaultHandler;
      if (defaultHandler) {
        // We call the default handler with arguments similar (slightly
        // simpler, there are no phases here) to middleware such that it can
        // easily access the message name (useful to implement proxies).
        defaultHandler.call(ctx, wreq, wres, prev);
      } else {
        prev(toRpcError('NOT_IMPLEMENTED'));
      }
    } else {
      var pending = !msg.oneWay;
      try {
        if (pending) {
          handler.call(ctx, wreq.request, function (err, res) {
            pending = false;
            wres.error = err;
            wres.response = res;
            prev();
          });
        } else {
          handler.call(ctx, wreq.request);
          prev();
        }
      } catch (err) {
        // We catch synchronous failures (same as express) and return the
        // failure. Note that the server process can still crash if an error
        // is thrown after the handler returns but before the response is
        // sent (again, same as express). We are careful to only trigger the
        // response callback once, emitting the errors afterwards instead.
        if (pending) {
          pending = false;
          prev(err);
        } else {
          onError(err);
        }
      }
    }
  }

  function onCompletion(err) {
    self.pending--;
    var server = self.server;
    var resBuf;
    if (!err) {
      var resErr = wres.error;
      var isStrict = server._strict;
      if (!isStrict) {
        if (isError(resErr)) {
          // If the error type is wrapped, we must wrap the error too.
          wres.error = msg.errorType.clone(resErr.message, {wrapUnions: true});
        } else if (resErr === null) {
          resErr = wres.error = undefined;
        }
      }
      try {
        resBuf = wres.toBuffer(msg);
      } catch (cause) {
        // Note that we don't add an RPC code here such that the client
        // receives the default `INTERNAL_SERVER_ERROR` one.
        if (wres.error !== undefined) {
          err = serializationError(
            f('invalid %s error', msg.name), // Sic.
            'err',
            wres.error,
            msg.errorType
          );
        } else {
          err = serializationError(
            f('invalid %s response', msg.name),
            'res',
            wres.response,
            msg.responseType
          );
        }
      }
    }
    if (!resBuf) {
      // The headers are only available if the message isn't one-way.
      resBuf = self._encodeSystemError(err, wres ? wres.headers : undefined);
    } else if (resErr !== undefined) {
      server.emit('error', toRpcError('APPLICATION_ERROR', resErr));
    }
    if (!self.destroyed) {
      cb(resBuf, msg.oneWay);
    }
    if (self.draining && !self.pending) {
      self.destroy();
    }
  }

  function onError(err) {
    self.emit('error', err);
  }
};

// Deprecated.

utils.addDeprecatedGetters(ServerChannel, ['pending']);

ServerChannel.prototype.getCache = util.deprecate(
  function () { return this.server._cache; },
  'use `.remoteProtocols()` instead of `.getCache()`'
);

ServerChannel.prototype.getProtocol = util.deprecate(
  function () {
    return this.server.service;
  },
  'use `.service` instead of `.getProtocol()`'
);

ServerChannel.prototype.isDestroyed = util.deprecate(
  function () { return this.destroyed; },
  'use `.destroyed` instead of `.isDestroyed`'
);

/**
 * Encode an error and optional header into a valid Avro response.
 *
 * @param err {Error} Error to encode.
 * @param header {Object} Optional response header.
 */
ServerChannel.prototype._encodeSystemError = function (err, header) {
  var server = this.server;
  server.emit('error', err, this);
  var errStr;
  if (server._sysErrFormatter) {
    // Format the error into a string to send over the wire.
    try {
      errStr = server._sysErrFormatter.call(this, err);
    } catch (cause) {
      server.emit('error', cause);
    }
  }
  var hdrBuf;
  if (header) {
    try {
      // Propagate the header if possible.
      hdrBuf = MAP_BYTES_TYPE.toBuffer(header);
    } catch (cause) {
      server.emit('error', cause);
    }
  }
  return Buffer.concat([
    hdrBuf || new Buffer([0]),
    new Buffer([1, 0]), // Error flag and first union index.
    STRING_TYPE.toBuffer(errStr || err.rpcCode || 'INTERNAL_SERVER_ERROR')
  ]);
};

/**
 * Server channel for stateless transport.
 *
 * This channel expect a handshake to precede each message.
 */
function StatelessServerChannel(server, readableFactory, opts) {
  ServerChannel.call(this, server, opts);
  var self = this;
  var readable;

  process.nextTick(function () {
    // Delay listening to allow handlers to be attached even if the factory is
    // purely synchronous.
    readable = readableFactory.call(this, function (err, writable) {
      if (err) {
        self.emit('error', err);
        // Since stateless channels are only used once, it is safe to destroy.
        onFinish();
        return;
      }
      self._writable = writable.on('finish', onFinish);
      self.emit('_writable');
    }).on('data', onRequest)
      .on('end', onEnd);
  });

  function onRequest(obj) {
    var id = obj.id;
    var buf = Buffer.concat(obj.payload);
    try {
      var parts = readHead(HANDSHAKE_REQUEST_TYPE, buf);
      var hreq = parts.head;
      var adapter = self._getAdapter(hreq);
    } catch (cause) {
      var err = toRpcError('INVALID_HANDSHAKE_REQUEST', cause);
      done(self._encodeSystemError(err));
      return;
    }

    self._receive(parts.tail, adapter, done);

    function done(resBuf) {
      if (!self._writable) {
        self.once('_writable', function () { done(resBuf); });
        return;
      }
      var hres = self._createHandshakeResponse(err, hreq);
      self.emit('handshake', hreq, hres);
      var payload = [
        HANDSHAKE_RESPONSE_TYPE.toBuffer(hres),
        resBuf
      ];
      self._writable.write({id: id, payload: payload});
      if (self._endWritable) {
        self._writable.end();
      }
    }
  }

  function onEnd() { self.destroy(); }

  function onFinish() {
    if (readable) {
      readable
        .removeListener('data', onRequest)
        .removeListener('end', onEnd);
    }
    self.destroy(true);
  }
}
util.inherits(StatelessServerChannel, ServerChannel);

/**
 * Stateful transport listener.
 *
 * A handshake is done when the channel first receives a message, then all
 * messages are sent without.
 */
function StatefulServerChannel(server, readable, writable, opts) {
  ServerChannel.call(this, server, opts);
  this._adapter = undefined;
  this._writable = writable.on('finish', onFinish);
  this._readable = readable.on('data', onHandshake).on('end', onEnd);

  this
    .once('_drain', function () {
      // Stop listening to incoming events.
      this._readable
        .removeListener('data', onHandshake)
        .removeListener('data', onRequest)
        .removeListener('end', onEnd);
    })
    .once('eot', function () {
      // Clean up any references to the channel on the underlying streams.
      this._writable.removeListener('finish', onFinish);
      if (this._endWritable) {
        this._writable.end();
      }
    });

  var self = this;

  function onHandshake(obj) {
    var id = obj.id;
    if (!self._matchesPrefix(id)) {
      return;
    }
    var buf = Buffer.concat(obj.payload);
    var err;
    try {
      var parts = readHead(HANDSHAKE_REQUEST_TYPE, buf);
      var hreq = parts.head;
      self._adapter = self._getAdapter(hreq);
    } catch (cause) {
      err = toRpcError('INVALID_HANDSHAKE_REQUEST', cause);
    }
    if (err) {
      // Either the client's protocol was unknown or it isn't compatible.
      done(self._encodeSystemError(err));
    } else {
      self._readable
        .removeListener('data', onHandshake)
        .on('data', onRequest);
      self._receive(parts.tail, self._adapter, done);
    }

    function done(resBuf) {
      var hres = self._createHandshakeResponse(err, hreq);
      self.emit('handshake', hreq, hres);
      var payload = [
        HANDSHAKE_RESPONSE_TYPE.toBuffer(hres),
        resBuf
      ];
      self._writable.write({id: id, payload: payload});
    }
  }

  function onRequest(obj) {
    // These requests are not prefixed with handshakes.
    var id = obj.id;
    if (!self._matchesPrefix(id)) {
      return;
    }
    var reqBuf = Buffer.concat(obj.payload);
    self._receive(reqBuf, self._adapter, function (resBuf, oneWay) {
      if (!oneWay) {
        self._writable.write({id: id, payload: [resBuf]});
      }
    });
  }

  function onEnd() { self.destroy(); }

  function onFinish() { self.destroy(true); }
}
util.inherits(StatefulServerChannel, ServerChannel);

// Helpers.

/** Enhanced request, used inside forward middleware functions. */
function WrappedRequest(msg, hdrs, req) {
  this._msg = msg; // Used internally.
  this.headers = hdrs || {};
  this.request = req || {};
}

WrappedRequest.prototype.toBuffer = function () {
  var msg = this._msg;
  return Buffer.concat([
    MAP_BYTES_TYPE.toBuffer(this.headers),
    STRING_TYPE.toBuffer(msg.name),
    msg.requestType.toBuffer(this.request)
  ]);
};

/** Enhanced response, used inside forward middleware functions. */
function WrappedResponse(hdr, err, res) {
  this.headers = hdr;
  this.error = err;
  this.response = res;
}

WrappedResponse.prototype.toBuffer = function (msg) {
  var hdr = MAP_BYTES_TYPE.toBuffer(this.headers);
  var hasError = this.error !== undefined;
  return Buffer.concat([
    hdr,
    BOOLEAN_TYPE.toBuffer(hasError),
    hasError ?
      msg.errorType.toBuffer(this.error) :
      msg.responseType.toBuffer(this.response)
  ]);
};

/**
 * Context for all middleware and handlers.
 *
 * It exposes a `locals` object which can be used to pass information between
 * each other during a given call.
 */
function CallContext(msg, channel) {
  this.message = msg;
  this.channel = channel;
  this.locals = {};
}

/**
 * Callback registry.
 *
 * Callbacks added must accept an error as first argument. This is used by
 * client channels to store pending calls. This class isn't exposed by the
 * public API.
 */
function Registry(ctx, prefixLength) {
  this._ctx = ctx; // Context for all callbacks.
  this._mask = ~0 >>> (prefixLength | 0); // 16 bits by default.
  this._id = 0; // Unique integer ID for each call.
  this._n = 0; // Number of pending calls.
  this._cbs = {};
}

Registry.prototype.get = function (id) { return this._cbs[id & this._mask]; };

Registry.prototype.add = function (timeout, fn) {
  this._id = (this._id + 1) & this._mask;

  var self = this;
  var id = this._id;
  var timer;
  if (timeout > 0) {
    timer = setTimeout(function () { cb(new Error('timeout')); }, timeout);
  }

  this._cbs[id] = cb;
  this._n++;
  return id;

  function cb() {
    if (!self._cbs[id]) {
      // The callback has already run.
      return;
    }
    delete self._cbs[id];
    self._n--;
    if (timer) {
      clearTimeout(timer);
    }
    fn.apply(self._ctx, arguments);
  }
};

Registry.prototype.clear = function () {
  Object.keys(this._cbs).forEach(function (id) {
    this._cbs[id](new Error('interrupted'));
  }, this);
};

/**
 * Service resolution helper.
 *
 * It is used both by client and server channels, to respectively decode errors
 * and responses, or requests.
 */
function Adapter(clientSvc, serverSvc, hash, isRemote) {
  this._clientSvc = clientSvc;
  this._serverSvc = serverSvc;
  this._hash = hash; // Convenience to access it when creating handshakes.
  this._isRemote = !!isRemote;
  this._readers = this._createReaders();
}

Adapter._populateCache = function (cache, svc, ptcls, isClient) {
  Object.keys(ptcls).forEach(function (hash) {
    var ptcl = ptcls[hash];
    var clientSvc, serverSvc;
    if (isClient) {
      clientSvc = svc;
      serverSvc = Service.forProtocol(ptcl, {wrapUnions: true});
    } else {
      clientSvc = Service.forProtocol(ptcl, {wrapUnions: true});
      serverSvc = svc;
    }
    cache[hash] = new Adapter(clientSvc, serverSvc, hash, true);
  });
  return cache;
};

Adapter._getRemoteProtocols = function (svc, cache, isClient) {
  var ptcls = {};
  Object.keys(cache).forEach(function (hs) {
    var adapter = cache[hs];
    if (adapter._isRemote) {
      var svc = isClient ? adapter._serverSvc : adapter._clientSvc;
      ptcls[hs] = svc.protocol;
    }
  });
  return ptcls;
};

Adapter.prototype._createReaders = function () {
  var obj = {};
  this._clientSvc.messages.forEach(function (c) {
    var n = c.name;
    var s = this._serverSvc.message(n);
    if (!s) {
      throw new Error(f('missing server message: %s', n));
    }
    if (s.oneWay !== c.oneWay) {
      throw new Error(f('inconsistent one-way parameter for message: %s', n));
    }
    try {
      obj[n + '?'] = createReader(s.requestType, c.requestType);
      obj[n + '*'] = createReader(c.errorType, s.errorType);
      obj[n + '!'] = createReader(c.responseType, s.responseType);
    } catch (cause) {
      throw toRpcError('INCOMPATIBLE_PROTOCOL', cause);
    }
  }, this);
  return obj;
};

Adapter.prototype._decodeRequest = function (buf) {
  var tap = new Tap(buf);
  var hdr = MAP_BYTES_TYPE._read(tap);
  var name = STRING_TYPE._read(tap);
  var msg, req;
  if (name) {
    msg = this._serverSvc.message(name);
    req = this._readers[name + '?']._read(tap);
  } else {
    msg = PING_MESSAGE;
  }
  if (!tap.isValid()) {
    throw new Error(f('truncated %s request', name || 'ping$'));
  }
  return new WrappedRequest(msg, hdr, req);
};

Adapter.prototype._decodeResponse = function (buf, wres, msg) {
  var tap = new Tap(buf);
  utils.copyOwnProperties(MAP_BYTES_TYPE._read(tap), wres.headers, true);
  var isError = BOOLEAN_TYPE._read(tap);
  var name = msg.name;
  if (name) {
    var reader = this._readers[name + (isError ? '*' : '!')];
    msg = this._clientSvc.message(name);
    if (isError) {
      wres.error = reader._read(tap);
    } else {
      wres.response = reader._read(tap);
    }
    if (!tap.isValid()) {
      throw new Error(f('truncated %s response', name));
    }
  } else {
    msg = PING_MESSAGE;
  }
};

/** Standard "un-framing" stream. */
function FrameDecoder() {
  stream.Transform.call(this, {readableObjectMode: true});
  this._id = undefined;
  this._buf = new Buffer(0);
  this._bufs = [];

  this.on('finish', function () { this.push(null); });
}
util.inherits(FrameDecoder, stream.Transform);

FrameDecoder.prototype._transform = function (buf, encoding, cb) {
  buf = Buffer.concat([this._buf, buf]);
  var frameLength;
  while (
    buf.length >= 4 &&
    buf.length >= (frameLength = buf.readInt32BE(0)) + 4
  ) {
    if (frameLength) {
      this._bufs.push(buf.slice(4, frameLength + 4));
    } else {
      var bufs = this._bufs;
      this._bufs = [];
      this.push({id: null, payload: bufs});
    }
    buf = buf.slice(frameLength + 4);
  }
  this._buf = buf;
  cb();
};

FrameDecoder.prototype._flush = function () {
  if (this._buf.length || this._bufs.length) {
    var bufs = this._bufs.slice();
    bufs.unshift(this._buf);
    var err = new Error('trailing data: %j', Buffer.concat(bufs).toString());
    this.emit('error', err);
  }
};

/** Standard framing stream. */
function FrameEncoder() {
  stream.Transform.call(this, {writableObjectMode: true});
  this.on('finish', function () { this.push(null); });
}
util.inherits(FrameEncoder, stream.Transform);

FrameEncoder.prototype._transform = function (obj, encoding, cb) {
  var bufs = obj.payload;
  var i, l, buf;
  for (i = 0, l = bufs.length; i < l; i++) {
    buf = bufs[i];
    this.push(intBuffer(buf.length));
    this.push(buf);
  }
  this.push(intBuffer(0));
  cb();
};

/** Netty-compatible decoding stream. */
function NettyDecoder() {
  stream.Transform.call(this, {readableObjectMode: true});
  this._id = undefined;
  this._frameCount = 0;
  this._buf = new Buffer(0);
  this._bufs = [];

  this.on('finish', function () { this.push(null); });
}
util.inherits(NettyDecoder, stream.Transform);

NettyDecoder.prototype._transform = function (buf, encoding, cb) {
  buf = Buffer.concat([this._buf, buf]);

  while (true) {
    if (this._id === undefined) {
      if (buf.length < 8) {
        this._buf = buf;
        cb();
        return;
      }
      this._id = buf.readInt32BE(0);
      this._frameCount = buf.readInt32BE(4);
      buf = buf.slice(8);
    }

    var frameLength;
    while (
      this._frameCount &&
      buf.length >= 4 &&
      buf.length >= (frameLength = buf.readInt32BE(0)) + 4
    ) {
      this._frameCount--;
      this._bufs.push(buf.slice(4, frameLength + 4));
      buf = buf.slice(frameLength + 4);
    }

    if (this._frameCount) {
      this._buf = buf;
      cb();
      return;
    } else {
      var obj = {id: this._id, payload: this._bufs};
      this._bufs = [];
      this._id = undefined;
      this.push(obj);
    }
  }
};

NettyDecoder.prototype._flush = FrameDecoder.prototype._flush;

/** Netty-compatible encoding stream. */
function NettyEncoder() {
  stream.Transform.call(this, {writableObjectMode: true});
  this.on('finish', function () { this.push(null); });
}
util.inherits(NettyEncoder, stream.Transform);

NettyEncoder.prototype._transform = function (obj, encoding, cb) {
  var bufs = obj.payload;
  var l = bufs.length;
  var buf;
  // Header: [ ID, number of frames ]
  buf = new Buffer(8);
  buf.writeInt32BE(obj.id, 0);
  buf.writeInt32BE(l, 4);
  this.push(buf);
  // Frames, each: [ length, bytes ]
  var i;
  for (i = 0; i < l; i++) {
    buf = bufs[i];
    this.push(intBuffer(buf.length));
    this.push(buf);
  }
  cb();
};

/**
 * Returns a buffer containing an integer's big-endian representation.
 *
 * @param n {Number} Integer.
 */
function intBuffer(n) {
  var buf = new Buffer(4);
  buf.writeInt32BE(n);
  return buf;
}

/**
 * Decode a type used as prefix inside a buffer.
 *
 * @param type {Type} The type of the prefix.
 * @param buf {Buffer} Encoded bytes.
 *
 * This function will return an object `{head, tail}` where head contains the
 * decoded value and tail the rest of the buffer. An error will be thrown if
 * the prefix cannot be decoded.
 */
function readHead(type, buf) {
  var tap = new Tap(buf);
  var head = type._read(tap);
  if (!tap.isValid()) {
    throw new Error(f('truncated %s', type));
  }
  return {head: head, tail: tap.buf.slice(tap.pos)};
}

/**
 * Generate a decoder, optimizing the case where reader and writer are equal.
 *
 * @param rtype {Type} Reader's type.
 * @param wtype {Type} Writer's type.
 */
function createReader(rtype, wtype) {
  return rtype.equals(wtype) ? rtype : rtype.createResolver(wtype);
}

/**
 * Check whether something is an `Error`.
 *
 * @param any {Object} Any object.
 */
function isError(any) {
  // Also not ideal, but avoids brittle `instanceof` checks.
  return !!any && Object.prototype.toString.call(any) === '[object Error]';
}

/**
 * Mark an error.
 *
 * @param rpcCode {String} Code representing the failure.
 * @param cause {Error} The cause of the error. It is available as `cause`
 * field on the outer error.
 *
 * This is used to keep the argument of channels' `'error'` event errors.
 */
function toRpcError(rpcCode, err) {
  if (typeof err == 'string') {
    err = new Error(err);
  } else if (!err) {
    err = new Error(rpcCode);
  }
  if (!err.rpcCode) {
    err.rpcCode = rpcCode;
  }
  return err;
}

/**
 * Provide a helpful error to identify why serialization failed.
 *
 * @param err {Error} The error to decorate.
 * @param val {...} The (invalid) value to serialize.
 * @param type {Type} The type used to serialize.
 */
function serializationError(msg, name, val, type) {
  var details = [];
  type.isValid(val, {errorHook: errorHook});
  var detailsStr = details.map(function (obj) {
    return f('%s%s = %j but expected %s', name, obj.path, obj.val, obj.type);
  }).join(', ');
  var err = new Error(f('%s (%s)', msg, detailsStr));
  err.details = details;
  return err;

  function errorHook(parts, any, type) {
    var strs = [];
    var i, l, part;
    for (i = 0, l = parts.length; i < l; i++) {
      part = parts[i];
      if (isNaN(part)) {
        strs.push('.' + part);
      } else {
        strs.push('[' + part + ']');
      }
    }
    details.push({path: strs.join(''), val: any, type: type});
  }
}

/**
 * Compute a prefix of fixed length from a string.
 *
 * @param scope {String} Namespace to be hashed.
 */
function normalizedPrefix(scope) {
  return scope ?
    utils.getHash(scope).readInt16BE(0) << (32 - PREFIX_LENGTH) :
    0;
}

/**
 * Check whether an ID matches the prefix.
 *
 * @param id {Integer} Number to check.
 * @param prefix {Integer} Already shifted prefix.
 */
function matchesPrefix(id, prefix) {
  return ((id ^ prefix) >> (32 - PREFIX_LENGTH)) === 0;
}

/**
 * Check whether something is a stream.
 *
 * @param any {Object} Any object.
 */
function isStream(any) {
  // This is a hacky way of checking that the transport is a stream-like
  // object. We unfortunately can't use `instanceof Stream` checks since
  // some libraries (e.g. websocket-stream) return streams which don't
  // inherit from it.
  return !!(any && any.pipe);
}

/**
 * Get a message, asserting that it exists.
 *
 * @param svc {Service} The protocol to look into.
 * @param name {String} The message's name.
 */
function getExistingMessage(svc, name) {
  var msg = svc.message(name);
  if (!msg) {
    throw new Error(f('unknown message: %s', name));
  }
  return msg;
}

/**
 * Middleware logic.
 *
 * This is used both in clients and servers to intercept call handling (e.g. to
 * populate headers, do access control).
 *
 * @param params {Object} The following parameters:
 *  + fns {Array} Array of middleware functions.
 *  + ctx {Object} Context used to call the middleware functions, onTransition,
 *    and onCompletion.
 *  + wreq {WrappedRequest}
 *  + wres {WrappedResponse}
 *  + onTransition {Function} End of forward phase callback. It accepts an
 *    eventual error as single argument. This will be used for the backward
 *    phase. This function is guaranteed to be called at most once.
 *  + onCompletion {Function} Final handler, it takes an error as unique
 *    argument. This function is guaranteed to be only at most once.
 *  + onError {Function} Error handler, called if an intermediate callback is
 *    called multiple times.
 */
function chainMiddleware(params) {
  var args = [params.wreq, params.wres];
  var cbs = [];
  var cause; // Backpropagated error.
  forward(0);

  function forward(pos) {
    var isDone = false;
    if (pos < params.fns.length) {
      params.fns[pos].apply(params.ctx, args.concat(function (err, cb) {
        if (isDone) {
          params.onError(new Error('duplicate middleware forward call'));
          return;
        }
        isDone = true;
        if (
          err ||
          params.wres.error !== undefined ||
          params.wres.response !== undefined
        ) {
          // Stop the forward phase, bypass the handler, and start the backward
          // phase. Note that we ignore any callback argument in this case.
          cause = err;
          backward();
          return;
        }
        if (cb) {
          cbs.push(cb);
        }
        forward(++pos);
      }));
    } else {
      // Done with the middleware forward functions, call the handler.
      params.onTransition.apply(params.ctx, args.concat(function (err) {
        if (isDone) {
          params.onError(new Error('duplicate transition call'));
          return;
        }
        isDone = true;
        cause = err;
        process.nextTick(backward);
      }));
    }
  }

  function backward() {
    var cb = cbs.pop();
    if (cb) {
      var isDone = false;
      cb.call(params.ctx, cause, function (err) {
        if (isDone) {
          params.onError(new Error('duplicate middleware backward call'));
          return;
        }
        if (err !== undefined) {
          cause = err;
        }
        isDone = true;
        backward();
      });
    } else {
      // Done with all middleware calls.
      params.onCompletion.call(params.ctx, cause);
    }
  }
}


module.exports = {
  Adapter: Adapter,
  HANDSHAKE_REQUEST_TYPE: HANDSHAKE_REQUEST_TYPE,
  HANDSHAKE_RESPONSE_TYPE: HANDSHAKE_RESPONSE_TYPE,
  Message: Message,
  Registry: Registry,
  Service: Service,
  discoverProtocol: discoverProtocol,
  streams: {
    FrameDecoder: FrameDecoder,
    FrameEncoder: FrameEncoder,
    NettyDecoder: NettyDecoder,
    NettyEncoder: NettyEncoder
  }
};