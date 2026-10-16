// Exercise the actual daemon with only external authentication/heartbeat mocked.
import os from 'node:os';
os.homedir = () => process.env.TEST_HOME;
const { AuthManager } = await import('../../.test-build/auth/auth-manager.js');
AuthManager.prototype.initialize = async () => {};
AuthManager.prototype.isLoggedIn = () => true;
const { KeepAlive } = await import('../../.test-build/runtime/keep-alive.js');
KeepAlive.prototype.start = () => {};
const { ConnectionRefresher } = await import('../../.test-build/runtime/connection-refresher.js');
ConnectionRefresher.prototype.start = () => {};
await import('../../.test-build/daemon/server.js');
