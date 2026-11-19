// @ts-nocheck
/**
 * Stand-in for lib/heos-player.js in local unit tests.
 * Records instances and counts calls; connect() and initMetaData() behaviour is set via
 * FakeHeosPlayer.connectImpl and FakeHeosPlayer.initMetaDataImpl, which receive the fake
 * player instance (initMetaDataImpl also the player entry).
 */
const defaultConnectImpl = async () => undefined;
const defaultInitMetaDataImpl = async () => undefined;

export default class FakeHeosPlayer {
    static instances = [];
    static connectImpl = defaultConnectImpl;
    static initMetaDataImpl = defaultInitMetaDataImpl;

    static reset() {
        FakeHeosPlayer.instances = [];
        FakeHeosPlayer.connectImpl = defaultConnectImpl;
        FakeHeosPlayer.initMetaDataImpl = defaultInitMetaDataImpl;
    }

    constructor(heos, player) {
        this.heos = heos;
        this.pid = player.pid;
        this.ip = player.ip;
        this.name = player.name;
        this.calls = { initMetaData: 0, connect: 0, disconnect: 0 };
        FakeHeosPlayer.instances.push(this);
    }

    async initMetaData(player) {
        this.calls.initMetaData += 1;
        await FakeHeosPlayer.initMetaDataImpl(this, player);
    }

    async connect() {
        this.calls.connect += 1;
        await FakeHeosPlayer.connectImpl(this);
    }

    async disconnect() {
        this.calls.disconnect += 1;
    }
}
