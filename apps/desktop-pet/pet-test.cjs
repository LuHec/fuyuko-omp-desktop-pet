const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PET_DIR = path.resolve(__dirname);
const ELEC = path.join(PET_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');

// Kill existing pet
try { require('child_process').execSync('taskkill /F /IM electron.exe 2>nul', { stdio: 'ignore' }); } catch {}

// Spawn with pipes
const p = spawn(ELEC, [PET_DIR], {
  cwd: PET_DIR,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

let pOut = '', pErr = '';
p.stdout.on('data', d => pOut += d);
p.stderr.on('data', d => pErr += d);

// Wait for process to be ready
setTimeout(() => {
  // Write state commands to stdin
  function write(cmd) {
    p.stdin.write(JSON.stringify(cmd) + '\n');
  }

  // Test sequence
  const SEQUENCE = [
    // 1. Set initial state to verifying readiness
    { type: 'state', state: 'waving' },
  ];

  for (const cmd of SEQUENCE) {
    write(cmd);
  }

  // After a brief delay, test more states
  setTimeout(() => {
    // 2. Test running state
    write({ type: 'state', state: 'running' });

    setTimeout(() => {
      // 3. Test review transient
      write({ type: 'state', state: 'review' });

      setTimeout(() => {
        // 4. Test failed
        write({ type: 'state', state: 'failed' });

        setTimeout(() => {
          // 5. Enable debug mode
          write({ type: 'debug_mode', enabled: true });

          // 6. Send debug events
          write({ type: 'debug', event: 'test_start', state: 'running', time: Date.now() });
          write({ type: 'debug', event: 'test_done', state: 'review', time: Date.now() });
          write({ type: 'debug', event: 'test_error', state: 'failed', time: Date.now() });

          setTimeout(() => {
            // 7. Back to idle
            write({ type: 'state', state: 'idle' });

            setTimeout(() => {
              // Output process info and exit
              console.log(JSON.stringify({
                pid: p.pid,
                running: p.exitCode === null,
                stdout: pOut.length,
                stderr: pErr.length,
                errPreview: pErr.slice(-300),
              }));
              // Don't quit — we want to visually inspect
              // write({ type: 'quit' });
            }, 300);
          }, 500);
        }, 300);
      }, 300);
    }, 300);
  }, 600);
}, 1500);

process.on('exit', () => {
  try { p.kill(); } catch {}
});
