import { spawn, ChildProcess } from 'child_process';
import { rmSync, mkdirSync } from 'fs';
import { writeFileSync } from 'fs';
import path from 'path';

const TEST_PORT = 3099;
const TEST_DATA_DIR = 'data-test';
const TEST_CONFIG_PATH = 'config.test.yml';

let serverProcess: ChildProcess | null = null;

// Test config with channel enabled
const testConfig = `
publicDomain: ""
databasePath: ${TEST_DATA_DIR}/sqlite.db

dashboard:
  enabled: false
  username: admin
  password: testpass

storage:
  backend: local
  removeWhenNoOwners: false
  local:
    dir: ./${TEST_DATA_DIR}/blobs
  rules:
    - type: "*"
      expiration: 1 day

upload:
  enabled: true
  requireAuth: false
  requirePubkeyInRule: false

media:
  enabled: false
  requireAuth: true
  requirePubkeyInRule: false

list:
  requireAuth: false
  allowListOthers: true

tor:
  enabled: false
  proxy: ""

channel:
  enabled: true
  secretKey: "0102030405060708091011121314151617181920212223242526272829303132"
  approvedMintsAndUnits:
    http://localhost:3338:
      - sat
      - usd
      - msat
  pricing:
    sat:
      perRequestPpk: 500
      perMegabytePpk: 1000
      minCapacity: 100
    usd:
      perRequestPpk: 100
      perMegabytePpk: 200
      minCapacity: 10
    msat:
      perRequestPpk: 500
      perMegabytePpk: 100
`;

async function waitForServer(port: number, timeoutMs: number = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // Use a simple endpoint that doesn't require channel config
      const response = await fetch(`http://localhost:${port}/`);
      console.log(`Health check: ${response.status} ${response.statusText}`);
      // Any response (even 404) means server is up
      if (response.status !== undefined) {
        // Give it a moment to fully initialize
        await new Promise(resolve => setTimeout(resolve, 500));
        return;
      }
    } catch (e) {
      // Server not ready yet
      console.log(`Waiting for server... ${e instanceof Error ? e.message : e}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

export async function setup() {
  // Clean up test data directory
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  mkdirSync(path.join(TEST_DATA_DIR, 'blobs'), { recursive: true });

  // Write test config
  writeFileSync(TEST_CONFIG_PATH, testConfig);

  // Start the server
  console.log(`Starting blossom-server on port ${TEST_PORT}...`);

  serverProcess = spawn('node', ['--loader', '@swc-node/register/esm', 'src/index.ts'], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      BLOSSOM_CONFIG: TEST_CONFIG_PATH,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: process.cwd(),
  });

  // Log server output for debugging
  serverProcess.stdout?.on('data', (data) => {
    console.log(`[server] ${data.toString().trim()}`);
  });
  serverProcess.stderr?.on('data', (data) => {
    console.error(`[server:err] ${data.toString().trim()}`);
  });

  serverProcess.on('error', (err) => {
    console.error('Failed to start server:', err);
  });

  // Wait for server to be ready
  await waitForServer(TEST_PORT);
  console.log('Server is ready!');

  // Store process for teardown
  (globalThis as any).__TEST_SERVER_PROCESS__ = serverProcess;
  (globalThis as any).__TEST_PORT__ = TEST_PORT;
}

export async function teardown() {
  const proc = (globalThis as any).__TEST_SERVER_PROCESS__ as ChildProcess | null;
  if (proc) {
    console.log('Stopping blossom-server...');
    proc.kill('SIGTERM');

    // Wait for process to exit
    await new Promise<void>((resolve) => {
      proc.on('exit', () => resolve());
      setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 5000);
    });
  }

  // Clean up test config
  rmSync(TEST_CONFIG_PATH, { force: true });
}
