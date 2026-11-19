// @ts-nocheck
/**
 * Local unit-test harness: loads main.js with @iobroker/adapter-core,
 * lib/heos-player.js and node:net swapped for fakes, so methods of the Heos
 * class can be tested without a js-controller installation or a network.
 */
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import sinon from 'sinon';
import { STATES } from '../../lib/constants.js';

const ADAPTER_CORE_URL = new URL('./fakes/adapter-core.js', import.meta.url).href;
const HEOS_PLAYER_URL = new URL('./fakes/heos-player.js', import.meta.url).href;
const NET_URL = new URL('./fakes/net.js', import.meta.url).href;
const MAIN_URL = new URL('../../main.js', import.meta.url).href;
const IO_PACKAGE_URL = new URL('../../io-package.json', import.meta.url);

// Register the resolve hook only once per process, even if this module is
// evaluated more than once (e.g. imported under different URLs).
const HOOK_KEY = Symbol.for('iobroker.heos.unitTestHooks');
if (!globalThis[HOOK_KEY]) {
    globalThis[HOOK_KEY] = registerHooks({
        resolve(specifier, context, nextResolve) {
            if (specifier === '@iobroker/adapter-core') {
                return { url: ADAPTER_CORE_URL, shortCircuit: true };
            }
            if (specifier.endsWith('/lib/heos-player.js')) {
                return { url: HEOS_PLAYER_URL, shortCircuit: true };
            }
            // Only main.js gets the fake socket; sinon, mocha and the fakes
            // themselves keep the real node:net.
            if (specifier === 'node:net' && context.parentURL === MAIN_URL) {
                return { url: NET_URL, shortCircuit: true };
            }
            return nextResolve(specifier, context);
        },
    });
}

const defaultNative = JSON.parse(readFileSync(IO_PACKAGE_URL, 'utf8')).native;

/**
 * Create a Heos instance on the fake adapter base.
 *
 * @param {object} [native] config values overriding the io-package.json defaults
 * @returns {Promise<object>} the Heos adapter instance
 */
export async function createHeos(native = {}) {
    const { default: startAdapter } = await import(MAIN_URL);
    return startAdapter({ config: { ...defaultNative, ...native } });
}

/**
 * Create a Heos instance that looks connected to the leader 10.0.0.1, with
 * the methods that reach the network or start recovery replaced by sinon stubs.
 *
 * @param {object} [native] config values overriding the io-package.json defaults
 * @param {object} [options] harness options
 * @param {boolean} [options.realReconnect] keep the real reconnect() instead of a stub
 * @returns {Promise<object>} the Heos adapter instance
 */
export async function connected(native = {}, { realReconnect = false } = {}) {
    const heos = await createHeos(native);
    heos.state = STATES.Connected;
    heos.ip = '10.0.0.1';
    for (const name of [
        ...(realReconnect ? [] : ['reconnect']),
        'signIn',
        'getGroups',
        'getPlayers',
        'updateKnownPlayerIPs',
        'raiseFailures',
        'raiseLeaderFailures',
        'reboot',
        'rebootAll',
    ]) {
        heos[name] = sinon.stub();
    }
    return heos;
}

/**
 * Build a complete player entry as HEOS returns it in get_players.
 *
 * @param {number} pid player id
 * @param {string} ip player IP address
 * @param {object} [extra] fields overriding or extending the defaults
 * @returns {object} the player entry
 */
export function entry(pid, ip, extra = {}) {
    return {
        name: `Player ${pid}`,
        pid,
        model: 'HEOS 1',
        version: '1.0.0',
        ip,
        network: 'wired',
        lineout: 0,
        serial: `SN${pid}`,
        ...extra,
    };
}
