// Live check of the Baichuan client: log in, subscribe, print normalized events for N seconds, log out.
// Needs only node (>= 18). Configuration via environment:
//   REOLINK_HOST (required), REOLINK_USER (required), REOLINK_PASSWORD (required),
//   REOLINK_PORT (default 9000), PROBE_SECONDS (default 60), PROBE_RAW=1 to also print raw push XML.
import { BaichuanClient } from '../src/baichuan/client';
import { formatEvent } from '../src/baichuan/events';

function env(name: string, def?: string): string {
    const v = process.env[name] ?? def;
    if (v === undefined || v === '') {
        console.error(`missing ${name}; set REOLINK_HOST, REOLINK_USER, REOLINK_PASSWORD`);
        process.exit(2);
    }
    return v;
}

const ts = () => new Date().toISOString();

async function main() {
    const host = env('REOLINK_HOST');
    const seconds = parseInt(env('PROBE_SECONDS', '60'), 10);
    const raw = process.env.PROBE_RAW === '1';
    const client = new BaichuanClient({
        host,
        port: parseInt(env('REOLINK_PORT', '9000'), 10),
        username: env('REOLINK_USER'),
        password: env('REOLINK_PASSWORD'),
    });
    let events = 0;
    client.on('state', s => console.log(`${ts()} state ${s}`));
    client.on('warn', e => console.log(`${ts()} warn ${e.message}`));
    client.on('login', d => console.log(`${ts()} login ok type=${d.type ?? '?'} channels=${d.channelNum ?? '?'}`));
    client.on('event', e => { events++; console.log(`${ts()} ${formatEvent(e)}`); });
    client.on('push', (f, xml) => console.log(`${ts()} push cmd=${f.cmd} ch_id=${f.chId}${raw && xml ? `\n${xml}` : ''}`));

    let stopping = false;
    const stop = async (why: string) => {
        if (stopping) return;
        stopping = true;
        console.log(`${ts()} stopping (${why}), logging out`);
        await client.stop();
        console.log(`${ts()} done: ${events} events, ${client.stats.reconnects} reconnects`);
        process.exit(client.stats.state === 'auth_failed' ? 1 : 0);
    };
    process.on('SIGINT', () => void stop('SIGINT'));
    process.on('SIGTERM', () => void stop('SIGTERM'));
    client.on('state', s => { if (s === 'auth_failed') void stop('bad credentials'); });

    console.log(`${ts()} connecting to ${host} for ${seconds} s`);
    client.start();
    setTimeout(() => void stop('time up'), seconds * 1000);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
