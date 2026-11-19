// @ts-nocheck
/**
 * Stand-in for @iobroker/adapter-core in local unit tests.
 *
 * Provides just enough of the Adapter base class for the real Heos
 * constructor and disconnect() to run without a js-controller or database:
 * - log calls are collected in `logs`
 * - timer helpers delegate to the globals so sinon fake timers apply
 * - getStatesAsync/getChannelsAsync return empty results
 * - the other base-class methods main.js calls are explicit async no-ops,
 *   so sinon can stub them; callback-style getters never invoke the callback
 *
 * Methods main.js does not use are deliberately absent: a misspelled or new
 * base-class call raises a TypeError instead of silently doing nothing.
 * idToDCS (used by onStateChange) is absent because a no-op would return a
 * wrong value; tests of that path have to provide it.
 */
import { EventEmitter } from 'node:events';

export class Adapter extends EventEmitter {
    constructor(options = {}) {
        super();
        this.name = options.name;
        this.namespace = 'heos.0';
        this.config = options.config ?? {};
        this.logs = [];
        this.log = {};
        for (const level of ['silly', 'debug', 'info', 'warn', 'error']) {
            this.log[level] = msg => this.logs.push({ level, msg });
        }
    }

    setTimeout(cb, ms, ...args) {
        return setTimeout(cb, ms, ...args);
    }

    clearTimeout(timer) {
        clearTimeout(timer);
    }

    setInterval(cb, ms, ...args) {
        return setInterval(cb, ms, ...args);
    }

    clearInterval(timer) {
        clearInterval(timer);
    }

    async getStatesAsync() {
        return {};
    }

    async getChannelsAsync() {
        return [];
    }

    async getState() {}

    async getStateAsync() {}

    async getStates() {}

    async setState() {}

    async setStateAsync() {}

    async setStateChanged() {}

    async setStateChangedAsync() {}

    async setObjectAsync() {}

    async delObject() {}

    async subscribeStates() {}

    async sendTo() {}
}
