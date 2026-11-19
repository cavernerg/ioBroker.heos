// @ts-nocheck
import sinon from 'sinon';
import { createHeos } from './harness.js';
import FakeHeosPlayer from './fakes/heos-player.js';
import { STATES } from '../../lib/constants.js';

describe('harness', () => {
    afterEach(() => {
        sinon.restore();
        FakeHeosPlayer.reset();
    });

    it('creates a Heos instance on the fake adapter base', async () => {
        const heos = await createHeos({ preferredIPs: '10.0.0.1,10.0.0.2' });
        heos.config.preferredIPs.should.equal('10.0.0.1,10.0.0.2');
        heos.updatePreferredPlayerIPs.should.be.a('function');
        heos.preferred_player_ips.should.deep.equal([]);
        heos.state.should.equal(STATES.Disconnected);
    });

    it('lets sinon stub the fake adapter methods', async () => {
        const heos = await createHeos();
        const stub = sinon.stub(heos, 'setStateAsync').resolves();
        await heos.disconnect();
        stub.should.have.been.calledWith('error', false, true);
    });

    it('gives main.js the fake player instead of lib/heos-player.js', async () => {
        const heos = await createHeos();
        sinon.stub(heos, 'signIn');
        sinon.stub(heos, 'getGroups');
        heos.state = STATES.Connected; // startPlayers abandons runs without a connection
        await heos.startPlayers([{ pid: 1, ip: '10.0.0.1', name: 'A' }]);
        FakeHeosPlayer.instances.should.have.length(1);
        heos.players['1'].should.equal(FakeHeosPlayer.instances[0]);
        heos.players['1'].calls.connect.should.equal(1);
    });
});

describe('preferred and next connect IPs', () => {
    it('keeps the leader in the preferred list after connecting to it', async () => {
        const heos = await createHeos({ preferredIPs: '10.0.0.1,10.0.0.2' });
        heos.manual_search_mode = true;
        heos.updatePreferredPlayerIPs();
        heos.removeNextConnectPlayerIp('10.0.0.1');
        heos.preferred_player_ips.should.deep.equal(['10.0.0.1', '10.0.0.2']);
        heos.next_connect_ips.should.deep.equal(['10.0.0.2']);
    });

    it('ignores blanks and empty elements in the configured list', async () => {
        const heos = await createHeos({ preferredIPs: '10.0.0.1, 10.0.0.2,,10.0.0.1' });
        heos.manual_search_mode = true;
        heos.updatePreferredPlayerIPs();
        heos.next_connect_ips.should.not.include('');
        heos.next_connect_ips.should.include('10.0.0.2');
    });
});

describe('refilling the connect list', () => {
    it('refills from preferred IPs when SSDP is disabled, even after the last entry failed', async () => {
        const heos = await createHeos({ preferredIPs: '10.0.0.1,10.0.0.2', disableSSDPDiscovery: true });
        heos.manual_search_mode = false;
        heos.next_connect_ips = [];
        heos.updatePreferredPlayerIPs();
        heos.next_connect_ips.should.deep.equal(['10.0.0.1', '10.0.0.2']);
    });

    it('does not fall back to stored player IPs when SSDP is disabled and no preferred IPs are set', async () => {
        const heos = await createHeos({ preferredIPs: '', disableSSDPDiscovery: true });
        heos.manual_search_mode = true;
        heos.known_player_ips = ['10.0.0.7', '10.0.0.8'];
        heos.next_connect_ips = [];
        heos.updatePreferredPlayerIPs();
        heos.next_connect_ips.should.deep.equal([]);
        heos.manual_search_mode.should.be.false;
    });

    it('treats a preferred list of only separators and blanks as no preferred IPs', async () => {
        const heos = await createHeos({ preferredIPs: ' , ', disableSSDPDiscovery: true });
        heos.manual_search_mode = true;
        heos.known_player_ips = ['10.0.0.7'];
        heos.next_connect_ips = [];
        heos.updatePreferredPlayerIPs();
        heos.next_connect_ips.should.deep.equal([]);
        heos.preferred_player_ips.should.deep.equal([]);
        heos.manual_search_mode.should.be.false;
    });

    it('leaves the list empty when SSDP is enabled and manual search mode is off', async () => {
        const heos = await createHeos({ preferredIPs: '10.0.0.1', disableSSDPDiscovery: false });
        heos.manual_search_mode = false;
        heos.next_connect_ips = [];
        heos.updatePreferredPlayerIPs();
        heos.next_connect_ips.should.deep.equal([]);
    });
});
