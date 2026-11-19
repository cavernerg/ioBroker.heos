// @ts-nocheck
/**
 * Stand-in for node:net in local unit tests (main.js only).
 * connect() returns a FakeSocket instead of opening a TCP connection. Sockets
 * are recorded in FakeSocket.instances, so tests can emit 'connect', 'error',
 * 'timeout', 'end' or 'data' on them by hand; write() collects the sent data
 * in `written`. isIP is the real implementation.
 */
import { EventEmitter } from 'node:events';
import { isIP } from 'node:net';

export class FakeSocket extends EventEmitter {
    static instances = [];

    static reset() {
        FakeSocket.instances = [];
    }

    constructor(host, port) {
        super();
        this.host = host;
        this.port = port;
        this.destroyed = false;
        this.written = [];
        FakeSocket.instances.push(this);
    }

    setKeepAlive() {
        return this;
    }

    setTimeout() {
        return this;
    }

    write(data) {
        this.written.push(data);
        return true;
    }

    destroy() {
        this.destroyed = true;
        return this;
    }

    unref() {
        return this;
    }
}

export default {
    connect({ host, port }) {
        return new FakeSocket(host, port);
    },
    isIP,
};
