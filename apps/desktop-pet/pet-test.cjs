const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

// Standalone smoke test for the pet. It launches the Electron pet, connects to
// its named pipe as a fake session, and drives it through a signal sequence so
// you can visually confirm each state renders. (The pet reads ONLY from the
// pipe now, so this is the real transport the extension uses.)

const PET_DIR = path.resolve(__dirname);
const ELEC = path.join(PET_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PIPE =
  process.platform === 'win32'
    ? '\\\\.\\pipe\\fuyuko-omp-pet'
    : path.join(PET_DIR, 'pet.sock');

let pOut = '';
let pErr = '';
const p = spawn(ELEC, [PET_DIR], {
  cwd: PET_DIR,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
p.stdout.on('data', (d) => { pOut += d; });
p.stderr.on('data', (d) => { pErr += d; });

function send(sock, msg) {
  sock.write(JSON.stringify(msg) + '\n');
}

function connect() {
  const sock = net.connect(PIPE);
  sock.on('connect', () => {
    console.log('[test] connected to pet pipe');
    const steps = [
      { type: 'state', agentActive: true, providerWaiting: true },            // waiting
      { type: 'state', providerWaiting: false, streaming: true },             // thinking
      { type: 'state', streaming: false, toolCount: 1 },                      // working
      { type: 'state', transient: 'failed' },                                 // failed
      { type: 'state', clearTransient: true, toolCount: 0, agentActive: false }, // idle
      { type: 'test', state: 'waving' },
    ];
    let i = 0;
    const tick = () => {
      if (i >= steps.length) {
        console.log(JSON.stringify({
          running: p.exitCode === null,
          stdout: pOut.length,
          stderr: pErr.length,
          errPreview: pErr.slice(-300),
        }));
        return;
      }
      console.log('[test] step', i, JSON.stringify(steps[i]));
      send(sock, steps[i++]);
      setTimeout(tick, 1200);
    };
    tick();
  });
  // Pet not listening yet — retry until it is.
  sock.on('error', () => setTimeout(connect, 300));
}

setTimeout(connect, 1500);

process.on('exit', () => {
  try { p.kill(); } catch { /* ignore */ }
});
