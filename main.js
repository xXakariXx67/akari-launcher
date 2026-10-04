const { app, BrowserWindow, ipcMain, Menu, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const crypto = require('crypto');
const { Auth } = require('msmc');
const { Client, Authenticator } = require('minecraft-launcher-core');
const { Client: DiscordRPCClient } = require('@xhayper/discord-rpc');
const { execFileSync, spawnSync } = require('child_process');
const { readModIconDataUrl } = require('./mod-icons');

let mainWindow;
let logsWindow = null;
let userAuth = null;
let discordPresenceClient = null;
let discordPresenceRetryTimer = null;
let discordPresenceConnecting = false;
let discordPresenceStopped = false;
let discordPresenceUnavailableLogged = false;
let discordPresenceWasConnected = false;
let discordPresenceDetails = 'Main Menu';
const discordPlayingInstances = [];

const DISCORD_APPLICATION_ID = '1556299312915284060';
const DISCORD_LARGE_IMAGE_KEY = 'akari-launcher-discord-1024';
const DISCORD_PRESENCE_RETRY_MS = 15000;

const defaultDataPath = path.join(app.getPath('userData'), 'instances');
const authFile = path.join(app.getPath('userData'), 'auth.json');
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_APP_SETTINGS = {
  theme: 'dark',
  autoCheckUpdates: true,
  launchMode: 'microsoft',
  offlineUsername: 'Player',
  offlineSkinMode: 'none',
  offlineSkinValue: ''
};
const APP_THEMES = ['dark', 'midnight', 'light'];
const CUSTOM_SKINLOADER_PROJECT_ID = 'idMHQ4n2';
const OFFLINE_SKIN_PROFILE_NAME = 'Akari Launcher Offline Skin';
const OFFLINE_SKIN_PROFILE_PATH = 'AkariLauncherOfflineSkin/skins/{USERNAME}.png';

function isValidOfflineUsername(username) {
  return typeof username === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(username);
}

function hideManagedModFile(filePath) {
  if (process.platform === 'win32') {
    execFileSync('attrib.exe', ['+h', filePath], { windowsHide: true, stdio: 'pipe' });
  }
}

function isValidHttpsImageUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) &&
      !url.username && !url.password;
  } catch {
    return false;
  }
}

function isValidOfflineSkinSettings(mode, value) {
  if (!['none', 'url', 'mojang'].includes(mode) ||
      typeof value !== 'string' || value.length > 2048) return false;
  if (mode === 'none') return true;
  return mode === 'url'
    ? isValidHttpsImageUrl(value)
    : isValidOfflineUsername(value);
}

const appIconPath = path.resolve(__dirname, 'icon', 'akari-launcher.png');

//const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const { autoUpdater } = require('electron-updater'); // <-- ADD THIS
//const path = require('path');

// ... (your existing main.js imports and functions) ...

app.whenReady().then(async () => {
  const instancesDir = await getInstancesDir();
  await fs.ensureDir(instancesDir);
  createWindow();
  startDiscordPresence();

  const settings = await readAppSettings();
  if (settings.autoCheckUpdates) {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.error("Update check failed:", err);
    });
  }
});

function scheduleDiscordPresenceRetry(delay = DISCORD_PRESENCE_RETRY_MS) {
  if (discordPresenceStopped || discordPresenceRetryTimer) return;
  discordPresenceRetryTimer = setTimeout(() => {
    discordPresenceRetryTimer = null;
    connectDiscordPresence();
  }, delay);
  discordPresenceRetryTimer.unref();
}

async function connectDiscordPresence() {
  if (discordPresenceStopped || discordPresenceConnecting ||
      !discordPresenceClient || discordPresenceClient.isConnected) {
    return;
  }

  discordPresenceConnecting = true;
  try {
    await discordPresenceClient.login();
    discordPresenceWasConnected = true;
    discordPresenceUnavailableLogged = false;
    await updateDiscordPresenceActivity();
  } catch (error) {
    if (discordPresenceClient.isConnected) {
      console.warn('Could not set Discord Rich Presence:', error.message);
    } else {
      if (!discordPresenceUnavailableLogged) {
        console.info('Discord Rich Presence is unavailable; it will retry while the launcher is open.', error.message);
        discordPresenceUnavailableLogged = true;
      }
      try {
        await discordPresenceClient.destroy();
      } catch (disconnectError) {
        console.warn('Could not close the Discord Rich Presence connection:', disconnectError.message);
      }
    }
  } finally {
    discordPresenceConnecting = false;
    if (!discordPresenceStopped && !discordPresenceClient.isConnected) {
      scheduleDiscordPresenceRetry();
    }
  }
}

function updateDiscordPresenceActivity() {
  if (!discordPresenceClient || !discordPresenceClient.isConnected ||
      !discordPresenceClient.user) {
    return Promise.resolve();
  }
  const playingInstance = discordPlayingInstances[discordPlayingInstances.length - 1];
  return discordPresenceClient.user.setActivity({
    name: 'Akari Launcher',
    details: playingInstance ? `Playing ${playingInstance}` : discordPresenceDetails,
    largeImageKey: DISCORD_LARGE_IMAGE_KEY,
    largeImageText: 'Akari Launcher'
  });
}

function startDiscordPresence() {
  discordPresenceClient = new DiscordRPCClient({ clientId: DISCORD_APPLICATION_ID });
  discordPresenceClient.on('disconnected', () => {
    if (discordPresenceWasConnected) {
      discordPresenceWasConnected = false;
      scheduleDiscordPresenceRetry(1000);
    }
  });
  void connectDiscordPresence();
}

ipcMain.handle('set-discord-presence-state', async (event, state) => {
  if (state !== 'main-menu' && state !== 'checking-mods') {
    throw new Error('Invalid Discord Rich Presence state.');
  }
  discordPresenceDetails = state === 'checking-mods' ? 'Checking Mods' : 'Main Menu';
  if (discordPlayingInstances.length === 0) {
    await updateDiscordPresenceActivity();
  }
  return true;
});

app.on('before-quit', () => {
  discordPresenceStopped = true;
  if (discordPresenceRetryTimer) {
    clearTimeout(discordPresenceRetryTimer);
    discordPresenceRetryTimer = null;
  }
  if (discordPresenceClient) {
    const client = discordPresenceClient;
    void (async () => {
      if (client.user) {
        try {
          await client.user.clearActivity();
        } catch (error) {
          console.warn('Could not clear Discord Rich Presence:', error.message);
        }
      }
      try {
        await client.destroy();
      } catch (error) {
        console.warn('Could not close Discord Rich Presence:', error.message);
      }
    })();
  }
});

const DEFAULT_VERSIONS = [
  '26.3', '26.2', '26.1.2', '26.1.1', '26.1', '1.21.11', '1.21.10',
  '1.21.9', '1.21.8', '1.21.7', '1.21.6', '1.21.5', '1.21.4', '1.21.3',
  '1.21.2', '1.21.1', '1.21', '1.20.6', '1.20.4', '1.20.2', '1.20.1',
  '1.19.4', '1.19.2', '1.18.2', '1.17.1', '1.16.5', '1.16.4', '1.16.3',
  '1.16.2'
];
const MIN_MINECRAFT_VERSION = '1.16.2';
const MOJANG_JAVA_RUNTIME_INDEX_URL =
  'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const minecraftJavaVersions = new Map();
let javaRuntimeManifestPromise = null;

function compareMinecraftVersions(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i++) {
    const difference = (leftParts[i] || 0) - (rightParts[i] || 0);
    if (difference) return difference;
  }
  return 0;
}

function isSupportedMinecraftVersion(version) {
  return typeof version === 'string' &&
    /^\d+\.\d+(?:\.\d+)?$/.test(version) &&
    compareMinecraftVersions(version, MIN_MINECRAFT_VERSION) >= 0;
}

function getNeoForgeVersionPrefix(minecraftVersion) {
  if (typeof minecraftVersion !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(minecraftVersion)) {
    return null;
  }
  const version = minecraftVersion.startsWith('1.')
    ? minecraftVersion.slice(2)
    : minecraftVersion;
  const [major, minor] = version.split('.');
  return `${major}.${minor}.`;
}

function getMojangJavaMajorVersion(executablePath) {
  const result = spawnSync(executablePath, ['-version'], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.error) return null;
  const versionOutput = `${result.stdout || ''}\n${result.stderr || ''}`;
  const versionMatch = /version\s+"(?:1\.)?(\d+)/i.exec(versionOutput);
  return versionMatch ? Number(versionMatch[1]) : null;
}

function getLocalJavaPaths() {
  const javaExecutable = process.platform === 'win32' ? 'java.exe' : 'java';
  const paths = [];
  if (process.env.JAVA_HOME) {
    paths.push(path.join(process.env.JAVA_HOME, 'bin', javaExecutable));
  }
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    const found = execFileSync(command, ['java'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    paths.push(...found.split(/\r?\n/).filter(Boolean));
  } catch {}
  return [...new Set(paths)];
}

function getRuntimePlatform() {
  if (process.platform !== 'win32') {
    throw new Error('Automatic Minecraft Java runtime setup is currently supported on Windows only.');
  }
  if (!['x64', 'arm64', 'ia32'].includes(process.arch)) {
    throw new Error(`Unsupported Windows architecture for Minecraft Java: ${process.arch}.`);
  }
  return `windows-${process.arch === 'ia32' ? 'x86' : process.arch}`;
}

async function getMinecraftJavaVersion(minecraftVersion) {
  if (minecraftJavaVersions.has(minecraftVersion)) {
    return minecraftJavaVersions.get(minecraftVersion);
  }
  const manifestResponse = await axios.get(
    'https://launchermeta.mojang.com/mc/game/version_manifest.json',
    { timeout: 20000, headers: { 'User-Agent': 'AkariLauncher/1.0.0' } }
  );
  const versionEntry = (manifestResponse.data.versions || [])
    .find(entry => entry && entry.id === minecraftVersion && entry.type === 'release');
  if (!versionEntry || !versionEntry.url) {
    throw new Error(`Could not find Minecraft ${minecraftVersion} runtime metadata.`);
  }
  const profileUrl = new URL(versionEntry.url);
  if (profileUrl.protocol !== 'https:' ||
      !['launchermeta.mojang.com', 'piston-meta.mojang.com'].includes(profileUrl.hostname)) {
    throw new Error('Mojang returned an unexpected Minecraft version metadata URL.');
  }
  const profileResponse = await axios.get(profileUrl.toString(), {
    timeout: 20000,
    headers: { 'User-Agent': 'AkariLauncher/1.0.0' }
  });
  const majorVersion = profileResponse.data &&
    profileResponse.data.javaVersion &&
    profileResponse.data.javaVersion.majorVersion;
  if (!Number.isInteger(majorVersion) || majorVersion < 8) {
    throw new Error(`Mojang did not specify a valid Java runtime for Minecraft ${minecraftVersion}.`);
  }
  minecraftJavaVersions.set(minecraftVersion, {
    majorVersion,
    component: profileResponse.data.javaVersion.component
  });
  return minecraftJavaVersions.get(minecraftVersion);
}

async function getJavaRuntimeManifest() {
  if (!javaRuntimeManifestPromise) {
    javaRuntimeManifestPromise = axios.get(MOJANG_JAVA_RUNTIME_INDEX_URL, {
      timeout: 20000,
      headers: { 'User-Agent': 'AkariLauncher/1.0.0' }
    }).then(response => response.data).catch(error => {
      javaRuntimeManifestPromise = null;
      throw error;
    });
  }
  return javaRuntimeManifestPromise;
}

async function installMojangJavaRuntime(component, platform) {
  const runtimeIndex = await getJavaRuntimeManifest();
  const availableVersions = runtimeIndex[platform] && runtimeIndex[platform][component];
  if (!Array.isArray(availableVersions) || availableVersions.length === 0) {
    throw new Error(`Mojang has no ${component} runtime for ${platform}.`);
  }
  const runtime = [...availableVersions].sort((left, right) =>
    Date.parse(right.version && right.version.released) -
    Date.parse(left.version && left.version.released)
  )[0];
  const runtimeManifestInfo = runtime && runtime.manifest;
  if (!runtimeManifestInfo ||
      !/^[a-f0-9]{40}$/i.test(runtimeManifestInfo.sha1 || '') ||
      typeof runtimeManifestInfo.url !== 'string') {
    throw new Error(`Mojang returned invalid metadata for the ${component} runtime.`);
  }
  const manifestUrl = new URL(runtimeManifestInfo.url);
  if (manifestUrl.protocol !== 'https:' ||
      !['piston-meta.mojang.com', 'launchermeta.mojang.com'].includes(manifestUrl.hostname)) {
    throw new Error('Mojang returned an unexpected Java runtime manifest URL.');
  }

  const runtimesPath = path.join(app.getPath('userData'), 'runtimes');
  const runtimePath = path.join(runtimesPath, component, runtimeManifestInfo.sha1);
  const javaPath = path.join(runtimePath, 'bin', 'java.exe');
  const markerPath = path.join(runtimePath, '.akari-runtime.json');
  if (await fs.pathExists(javaPath) && await fs.pathExists(markerPath)) {
    return javaPath;
  }

  const manifestResponse = await axios.get(manifestUrl.toString(), {
    responseType: 'arraybuffer',
    timeout: 30000,
    maxContentLength: 10 * 1024 * 1024,
    headers: { 'User-Agent': 'AkariLauncher/1.0.0' }
  });
  const manifestBytes = Buffer.from(manifestResponse.data);
  if ((runtimeManifestInfo.size && manifestBytes.length !== runtimeManifestInfo.size) ||
      crypto.createHash('sha1').update(manifestBytes).digest('hex').toLowerCase() !==
      runtimeManifestInfo.sha1.toLowerCase()) {
    throw new Error(`The ${component} runtime manifest failed its integrity check.`);
  }
  let runtimeManifest;
  try {
    runtimeManifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error(`Mojang returned invalid ${component} runtime data.`);
  }
  if (!runtimeManifest.files || typeof runtimeManifest.files !== 'object') {
    throw new Error(`Mojang returned an incomplete ${component} runtime manifest.`);
  }

  await fs.ensureDir(runtimesPath);
  const stagingPath = await fs.mkdtemp(path.join(runtimesPath, '.akari-runtime-'));
  try {
    const files = Object.entries(runtimeManifest.files);
    let nextFileIndex = 0;
    let completedFiles = 0;
    let lastLoggedProgress = -10;
    const worker = async () => {
      while (nextFileIndex < files.length) {
        const index = nextFileIndex++;
        const [relativePath, fileInfo] = files[index];
        const destination = path.resolve(stagingPath, ...relativePath.split(/[\\/]/));
        if (path.relative(stagingPath, destination).startsWith('..')) {
          throw new Error('Mojang returned an unsafe path in the Java runtime manifest.');
        }
        if (!fileInfo || fileInfo.type === 'directory') {
          await fs.ensureDir(destination);
        } else {
          if (fileInfo.type !== 'file' ||
              !fileInfo.downloads || !fileInfo.downloads.raw ||
              !/^[a-f0-9]{40}$/i.test(fileInfo.downloads.raw.sha1 || '') ||
              !Number.isSafeInteger(fileInfo.downloads.raw.size) ||
              typeof fileInfo.downloads.raw.url !== 'string') {
            throw new Error(`Mojang returned an unsupported Java runtime file: ${relativePath}.`);
          }
          const fileUrl = new URL(fileInfo.downloads.raw.url);
          if (fileUrl.protocol !== 'https:' ||
              !['piston-data.mojang.com', 'launcher.mojang.com'].includes(fileUrl.hostname)) {
            throw new Error('Mojang returned an unexpected Java runtime file URL.');
          }
          const download = await axios.get(fileUrl.toString(), {
            responseType: 'arraybuffer',
            timeout: 120000,
            maxContentLength: fileInfo.downloads.raw.size,
            headers: { 'User-Agent': 'AkariLauncher/1.0.0' }
          });
          const bytes = Buffer.from(download.data);
          if (bytes.length !== fileInfo.downloads.raw.size ||
              crypto.createHash('sha1').update(bytes).digest('hex').toLowerCase() !==
                fileInfo.downloads.raw.sha1.toLowerCase()) {
            throw new Error(`Java runtime file failed its integrity check: ${relativePath}.`);
          }
          await fs.ensureDir(path.dirname(destination));
          await fs.writeFile(destination, bytes, { flag: 'wx' });
        }
        const progress = Math.floor((++completedFiles / files.length) * 100);
        if (progress >= lastLoggedProgress + 10) {
          lastLoggedProgress = progress;
          sendLogToWindows(`[PROGRESS] Downloading Java ${runtime.version.name}: ${progress}%\n`);
        }
      }
    };
    const workerResults = await Promise.allSettled(
      Array.from({ length: 8 }, () => worker())
    );
    const failedWorker = workerResults.find(result => result.status === 'rejected');
    if (failedWorker) throw failedWorker.reason;
    if (!await fs.pathExists(path.join(stagingPath, 'bin', 'java.exe'))) {
      throw new Error(`The downloaded ${component} runtime has no java.exe.`);
    }
    await fs.writeJson(path.join(stagingPath, '.akari-runtime.json'), {
      component,
      version: runtime.version.name,
      manifestSha1: runtimeManifestInfo.sha1
    });
    await fs.remove(runtimePath);
    await fs.ensureDir(path.dirname(runtimePath));
    await fs.move(stagingPath, runtimePath);
  } finally {
    await fs.remove(stagingPath);
  }
  return javaPath;
}

async function resolveMinecraftJava(minecraftVersion) {
  const required = await getMinecraftJavaVersion(minecraftVersion);
  for (const javaPath of getLocalJavaPaths()) {
    if (getMojangJavaMajorVersion(javaPath) === required.majorVersion) {
      return { javaPath, majorVersion: required.majorVersion };
    }
  }
  const platform = getRuntimePlatform();
  const javaPath = await installMojangJavaRuntime(required.component, platform);
  if (getMojangJavaMajorVersion(javaPath) !== required.majorVersion) {
    throw new Error(`The downloaded Java runtime does not match the required Java ${required.majorVersion}.`);
  }
  return { javaPath, majorVersion: required.majorVersion };
}

async function getInstancesDir() {
  try {
    if (await fs.pathExists(settingsFile)) {
      const settings = await fs.readJson(settingsFile);
      if (settings.instancesDir) {
        await fs.ensureDir(settings.instancesDir);
        return settings.instancesDir;
      }
    }
  } catch (error) {
    console.error("Failed to read settings, falling back to default path:", error);
  }
  await fs.ensureDir(defaultDataPath);
  return defaultDataPath;
}

async function readAppSettings() {
  try {
    if (await fs.pathExists(settingsFile)) {
      const settings = await fs.readJson(settingsFile);
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        throw new Error('Settings file must contain a JSON object');
      }
      return {
        theme: APP_THEMES.includes(settings.theme) ? settings.theme : DEFAULT_APP_SETTINGS.theme,
        autoCheckUpdates: typeof settings.autoCheckUpdates === 'boolean'
          ? settings.autoCheckUpdates
          : DEFAULT_APP_SETTINGS.autoCheckUpdates,
        launchMode: settings.launchMode === 'offline' ? 'offline' : 'microsoft',
        offlineUsername: isValidOfflineUsername(settings.offlineUsername)
          ? settings.offlineUsername
          : DEFAULT_APP_SETTINGS.offlineUsername,
        offlineSkinMode: isValidOfflineSkinSettings(settings.offlineSkinMode, settings.offlineSkinValue)
          ? settings.offlineSkinMode
          : DEFAULT_APP_SETTINGS.offlineSkinMode,
        offlineSkinValue: isValidOfflineSkinSettings(settings.offlineSkinMode, settings.offlineSkinValue)
          ? settings.offlineSkinValue
          : DEFAULT_APP_SETTINGS.offlineSkinValue
      };
    }
  } catch (error) {
    console.error('Failed to read app settings:', error);
    return { ...DEFAULT_APP_SETTINGS };
  }
  return { ...DEFAULT_APP_SETTINGS };
}

function normalizeMemorySettings(memory = {}) {
  if (!memory || typeof memory !== 'object' || Array.isArray(memory)) {
    throw new Error('Invalid instance memory settings');
  }
  const min = memory.min === undefined ? 2 : Number(memory.min);
  const max = memory.max === undefined ? 4 : Number(memory.max);
  if (!Number.isInteger(min) || !Number.isInteger(max) ||
      min < 1 || max > 32 || min > max) {
    throw new Error('Memory must be whole numbers between 1 and 32 GB, with minimum not greater than maximum');
  }
  return { min, max };
}

function parseInstanceName(input) {
  if (typeof input === 'object' && input !== null) {
    return String(input.instanceName || input.name || '');
  }
  return String(input || '');
}

function resolveInstancePath(instancesDir, input) {
  const name = parseInstanceName(input);
  const root = path.resolve(instancesDir);
  const instancePath = path.resolve(root, name);

  if (!name || path.basename(name) !== name || path.dirname(instancePath) !== root) {
    throw new Error('Invalid instance name');
  }

  return { name, instancePath };
}

// Unified log sender emitting on BOTH channels for backwards compatibility
function sendLogToWindows(data) {
  const message = (typeof data === 'string') ? data : (data ? data.toString() : '');

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('download-progress', message);
    mainWindow.webContents.send('log-data', message);
  }
  if (logsWindow && !logsWindow.isDestroyed()) {
    logsWindow.webContents.send('download-progress', message);
    logsWindow.webContents.send('log-data', message);
  }
}

function createWindow() {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 950,
    height: 700,
    minWidth: 782,
    minHeight: 686,
    title: `Akari Launcher v${app.getVersion()}`,
    resizable: true,
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.on('page-title-updated', (event) => event.preventDefault());
  mainWindow.loadFile('index.html');
}

function createLogsWindow() {
  if (logsWindow && !logsWindow.isDestroyed()) {
    logsWindow.focus();
    return;
  }

  logsWindow = new BrowserWindow({
    width: 700,
    height: 500,
    title: 'Game Logs',
    resizable: true,
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  logsWindow.loadFile('logs.html');
  logsWindow.on('closed', () => {
    logsWindow = null;
  });
}

// --- SETTINGS / FOLDER IPC HANDLERS ---

ipcMain.handle('get-app-settings', async () => {
  return await readAppSettings();
});

ipcMain.handle('save-app-settings', async (event, preferences) => {
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
    throw new Error('Invalid app settings');
  }
  if (!APP_THEMES.includes(preferences.theme) ||
      typeof preferences.autoCheckUpdates !== 'boolean' ||
      !['microsoft', 'offline'].includes(preferences.launchMode) ||
      !isValidOfflineUsername(preferences.offlineUsername) ||
      !isValidOfflineSkinSettings(preferences.offlineSkinMode, preferences.offlineSkinValue)) {
    throw new Error('Invalid app settings');
  }

  const storedSettings = await fs.pathExists(settingsFile)
    ? await fs.readJson(settingsFile)
    : {};
  await fs.writeJson(settingsFile, {
    ...storedSettings,
    theme: preferences.theme,
    autoCheckUpdates: preferences.autoCheckUpdates,
    launchMode: preferences.launchMode,
    offlineUsername: preferences.offlineUsername,
    offlineSkinMode: preferences.offlineSkinMode,
    offlineSkinValue: preferences.offlineSkinValue
  });
  return {
    theme: preferences.theme,
    autoCheckUpdates: preferences.autoCheckUpdates,
    launchMode: preferences.launchMode,
    offlineUsername: preferences.offlineUsername,
    offlineSkinMode: preferences.offlineSkinMode,
    offlineSkinValue: preferences.offlineSkinValue
  };
});

ipcMain.handle('get-download-location', async () => {
  return await getInstancesDir();
});

ipcMain.handle('select-download-location', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Folder for Minecraft Instances',
    properties: ['openDirectory', 'createDirectory']
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const newPath = result.filePaths[0];
    try {
      let settings = {};
      if (await fs.pathExists(settingsFile)) {
        settings = await fs.readJson(settingsFile);
      }
      settings.instancesDir = newPath;
      await fs.writeJson(settingsFile, settings);
      await fs.ensureDir(newPath);
      return { success: true, path: newPath };
    } catch (error) {
      console.error("Failed to save new download location:", error);
      return { success: false, error: error.message };
    }
  }
  return { success: false, canceled: true };
});

ipcMain.handle('open-logs-window', () => {
  createLogsWindow();
  return true;
});

ipcMain.handle('open-instance-folder', async (event, instanceName) => {
  const instancesDir = await getInstancesDir();
  const { instancePath } = resolveInstancePath(instancesDir, instanceName);
  await fs.ensureDir(instancePath);
  const error = await shell.openPath(instancePath);
  if (error) throw new Error(`Could not open instance folder: ${error}`);
  return true;
});

ipcMain.handle('get-saved-user', async () => {
  try {
    if (await fs.pathExists(authFile)) {
      userAuth = await fs.readJson(authFile);
      return { name: userAuth.name, uuid: userAuth.uuid };
    }
  } catch (error) {
    console.error("Failed to load saved auth:", error);
  }
  return null;
});

ipcMain.handle('ms-login', async () => {
  try {
    const authManager = new Auth("select_account");
    const xboxManager = await authManager.launch("electron");
    const token = await xboxManager.getMinecraft();
    
    userAuth = token.mclc();
    await fs.writeJson(authFile, userAuth);

    return { name: userAuth.name, uuid: userAuth.uuid };
  } catch (error) {
    console.error("Login Exception:", error);
    return null;
  }
});

ipcMain.handle('ms-logout', async () => {
  userAuth = null;
  if (await fs.pathExists(authFile)) {
    await fs.remove(authFile);
  }
  return true;
});

ipcMain.handle('get-mc-versions', async () => {
  try {
    const res = await axios.get('https://launchermeta.mojang.com/mc/game/version_manifest.json', {
      headers: { 'User-Agent': 'AkariLauncher/1.0.0' }
    });
    const versions = res.data.versions
      .filter(v => v.type === 'release' && isSupportedMinecraftVersion(v.id))
      .map(v => v.id);
    return versions.length > 0 ? versions : DEFAULT_VERSIONS;
  } catch (error) {
    console.error('Failed to fetch MC versions, using default list:', error.message);
    return DEFAULT_VERSIONS.filter(isSupportedMinecraftVersion);
  }
});

ipcMain.handle('get-neoforge-versions', async (event, mcVersion) => {
  try {
    const mavenRes = await axios.get('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge', {
      headers: { 'User-Agent': 'AkariLauncher/1.0.0' }
    });

    const versions = mavenRes.data.versions || [];

    const targetPrefix = getNeoForgeVersionPrefix(mcVersion);
    if (!targetPrefix) return [];
    return versions.filter(v => v.startsWith(targetPrefix)).reverse();
  } catch (err) {
    console.error("Failed to fetch NeoForge versions:", err.message);
    return [];
  }
});

ipcMain.handle('get-fabric-versions', async (event, mcVersion) => {
  try {
    const response = await axios.get(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`, {
      headers: { 'User-Agent': 'AkariLauncher/1.0.0' }
    });
    return (response.data || [])
      .map(item => item.loader && item.loader.version)
      .filter(version => typeof version === 'string');
  } catch (error) {
    console.error('Failed to fetch Fabric loader versions:', error.message);
    throw error;
  }
});

ipcMain.handle('get-instances', async () => {
  const instancesDir = await getInstancesDir();
  await fs.ensureDir(instancesDir);
  const folders = await fs.readdir(instancesDir, { withFileTypes: true });
  return folders.filter(f => f.isDirectory()).map(f => String(f.name));
});

ipcMain.handle('create-instance', async (event, payload) => {
  const instancesDir = await getInstancesDir();
  const { instancePath } = resolveInstancePath(instancesDir, payload);
  const version = (typeof payload === 'object' && payload.version) ? payload.version : '1.20.1';
  const loader = (typeof payload === 'object' && payload.loader) ? payload.loader : 'vanilla';
  const neoforgeVersion = (typeof payload === 'object' && payload.neoforgeVersion) ? payload.neoforgeVersion : null;
  if (!isSupportedMinecraftVersion(version)) {
    throw new Error(`Minecraft ${MIN_MINECRAFT_VERSION} or newer is required.`);
  }
  if (!['vanilla', 'fabric', 'forge', 'neoforge'].includes(loader)) {
    throw new Error('Invalid Minecraft loader.');
  }
  if (loader === 'neoforge') {
    const prefix = getNeoForgeVersionPrefix(version);
    if (!prefix || typeof neoforgeVersion !== 'string' || !neoforgeVersion.startsWith(prefix)) {
      throw new Error(`No compatible NeoForge build was selected for Minecraft ${version}.`);
    }
  }
  const memory = normalizeMemorySettings(payload && payload.memory);

  const modsPath = path.join(instancePath, 'mods');
  const resourcepacksPath = path.join(instancePath, 'resourcepacks');
  const shaderpacksPath = path.join(instancePath, 'shaderpacks');
  const configFile = path.join(instancePath, 'config.json');

  await fs.ensureDir(modsPath);
  await fs.ensureDir(resourcepacksPath);
  await fs.ensureDir(shaderpacksPath);

  await fs.writeJson(configFile, {
    version,
    loader,
    neoforgeVersion,
    loaderVersion: loader === 'fabric' ? payload.loaderVersion || null : null,
    memory
  });
  return true;
});

ipcMain.handle('delete-instance', async (event, instanceName) => {
  const instancesDir = await getInstancesDir();
  const { instancePath } = resolveInstancePath(instancesDir, instanceName);
  if (await fs.pathExists(instancePath)) {
    const instanceStat = await fs.lstat(instancePath);
    if (instanceStat.isSymbolicLink()) {
      throw new Error('Refusing to delete an instance symbolic link');
    }
    await fs.remove(instancePath);
    return true;
  }
  return false;
});

ipcMain.handle('get-instance-info', async (event, instanceName) => {
  const instancesDir = await getInstancesDir();
  const { instancePath } = resolveInstancePath(instancesDir, instanceName);
  const configFile = path.join(instancePath, 'config.json');
  if (await fs.pathExists(configFile)) {
    return await fs.readJson(configFile);
  }
  return { version: '1.20.1', loader: 'vanilla' };
});

ipcMain.handle('save-instance-settings', async (event, payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid instance settings');
  }

  const instancesDir = await getInstancesDir();
  const { instancePath } = resolveInstancePath(instancesDir, payload.instanceName);
  const configFile = path.join(instancePath, 'config.json');
  let config = {};
  if (await fs.pathExists(configFile)) {
    config = await fs.readJson(configFile);
  }

  const memory = normalizeMemorySettings(payload.memory);
  if (payload.loaderVersion !== undefined &&
      (typeof payload.loaderVersion !== 'string' || payload.loaderVersion.length > 64)) {
    throw new Error('Invalid Fabric loader version');
  }
  await fs.writeJson(configFile, {
    ...config,
    version: config.version || '1.20.1',
    loader: config.loader || 'vanilla',
    memory,
    ...(payload.loaderVersion !== undefined ? { loaderVersion: payload.loaderVersion } : {})
  });
  return { memory, loaderVersion: config.loader === 'fabric' ? payload.loaderVersion || null : null };
});

ipcMain.handle('set-mod-enabled', async (event, payload) => {
  const { instanceName, filename, enabled } = payload || {};
  if (typeof filename !== 'string' || path.basename(filename) !== filename ||
      !/^[^<>:"/\\|?*\x00-\x1f]+\.(jar|zip)$/i.test(filename) ||
      typeof enabled !== 'boolean') {
    throw new Error('Invalid mod toggle request');
  }
  const instancesDir = await getInstancesDir();
  const { instancePath } = resolveInstancePath(instancesDir, instanceName);
  const modsPath = path.join(instancePath, 'mods');
  const disabledPath = path.join(instancePath, 'disabled-mods');
  await fs.ensureDir(modsPath);
  await fs.ensureDir(disabledPath);

  const source = path.join(enabled ? disabledPath : modsPath, filename);
  const destination = path.join(enabled ? modsPath : disabledPath, filename);
  if (!await fs.pathExists(source)) {
    throw new Error('Mod file not found');
  }
  if (await fs.pathExists(destination)) {
    throw new Error(`A mod named "${filename}" already exists in the ${enabled ? 'enabled' : 'disabled'} mods folder`);
  }
  await fs.move(source, destination);
  return { filename, enabled };
});

ipcMain.handle('migrate-instance-version', async (event, payload) => {
  if (!payload || typeof payload !== 'object' ||
      typeof payload.instanceName !== 'string' ||
      typeof payload.version !== 'string' ||
      !isSupportedMinecraftVersion(payload.version)) {
    throw new Error('Invalid Minecraft version migration request');
  }

  const instancesDir = await getInstancesDir();
  const { instancePath } = resolveInstancePath(instancesDir, payload.instanceName);
  const configPath = path.join(instancePath, 'config.json');
  const metadataPath = path.join(instancePath, 'mods-metadata.json');
  const modsPath = path.join(instancePath, 'mods');
  const disabledPath = path.join(instancePath, 'disabled-mods');
  const config = await fs.pathExists(configPath) ? await fs.readJson(configPath) : {};
  const loader = String(config.loader || 'vanilla').toLowerCase();
  const targetVersion = payload.version;

  let loaderVersion = config.loaderVersion || null;
  if (loader === 'fabric') {
    const response = await axios.get(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(targetVersion)}`, {
      headers: { 'User-Agent': 'AkariLauncher/1.0.0' }
    });
    loaderVersion = response.data && response.data[0] && response.data[0].loader
      ? response.data[0].loader.version
      : null;
    if (!loaderVersion) {
      throw new Error(`No Fabric loader build is available for Minecraft ${targetVersion}`);
    }
  }

  await fs.ensureDir(modsPath);
  await fs.ensureDir(disabledPath);
  const metadataExisted = await fs.pathExists(metadataPath);
  const metadata = metadataExisted ? await fs.readJson(metadataPath) : {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Invalid mods metadata file');
  }

  const activeFiles = (await fs.readdir(modsPath)).filter(filename => /\.(jar|zip)$/i.test(filename));
  const disabledFiles = (await fs.readdir(disabledPath))
    .filter(filename => /\.(jar|zip)$/i.test(filename))
    .filter(filename => !activeFiles.includes(filename));
  const candidates = [
    ...activeFiles.map(filename => ({ filename, enabled: true })),
    ...disabledFiles.map(filename => ({ filename, enabled: false }))
  ];
  const stagePath = await fs.mkdtemp(path.join(instancePath, '.akari-migration-'));
  const plans = [];
  const backups = [];
  const installedFiles = [];
  const configExisted = await fs.pathExists(configPath);
  const originalConfig = { ...config };
  const originalMetadata = { ...metadata };

  try {
    for (const candidate of candidates) {
      const info = metadata[candidate.filename] || {};
      let compatibleRelease = null;
      if (typeof info.projectId === 'string' && info.projectId) {
        const params = { game_versions: JSON.stringify([targetVersion]) };
        if (loader !== 'vanilla') params.loaders = JSON.stringify([loader]);
        const response = await axios.get(
          `https://api.modrinth.com/v2/project/${encodeURIComponent(info.projectId)}/version`,
          { params, headers: { 'User-Agent': 'AkariLauncher/1.0.0' } }
        );
        compatibleRelease = (response.data || []).find(release =>
          Array.isArray(release.game_versions) &&
          release.game_versions.includes(targetVersion) &&
          (loader === 'vanilla' || (Array.isArray(release.loaders) && release.loaders.includes(loader)))
        ) || null;
      }

      let stagedFile = null;
      let nextFilename = candidate.filename;
      if (compatibleRelease && Array.isArray(compatibleRelease.files) && compatibleRelease.files.length) {
        const file = compatibleRelease.files.find(item => item && item.primary) || compatibleRelease.files[0];
        if (file && typeof file.filename === 'string' &&
            path.basename(file.filename) === file.filename &&
            /^[^<>:"/\\|?*\x00-\x1f]+\.(jar|zip)$/i.test(file.filename) &&
            typeof file.url === 'string') {
          const download = await axios.get(file.url, { responseType: 'arraybuffer' });
          stagedFile = path.join(stagePath, `${plans.length}.jar`);
          await fs.writeFile(stagedFile, Buffer.from(download.data));
          nextFilename = file.filename;
        } else {
          compatibleRelease = null;
        }
      } else {
        compatibleRelease = null;
      }

      const enabled = Boolean(compatibleRelease) && candidate.enabled;
      plans.push({
        ...candidate,
        info,
        compatibleRelease,
        stagedFile,
        nextFilename,
        nextEnabled: enabled
      });
    }

    const finalPaths = new Set();
    const metadataNames = new Set();
    for (const plan of plans) {
      const folder = plan.nextEnabled ? modsPath : disabledPath;
      const finalPath = path.join(folder, plan.nextFilename);
      if (finalPaths.has(finalPath)) {
        throw new Error(`Multiple mods would use the filename "${plan.nextFilename}" after migration`);
      }
      if (metadataNames.has(plan.nextFilename)) {
        throw new Error(`Multiple mods would share metadata for "${plan.nextFilename}" after migration`);
      }
      finalPaths.add(finalPath);
      metadataNames.add(plan.nextFilename);
      plan.sourcePath = path.join(plan.enabled ? modsPath : disabledPath, plan.filename);
      plan.finalPath = finalPath;
    }

    for (let index = 0; index < plans.length; index += 1) {
      const plan = plans[index];
      const needsUpdate = Boolean(plan.compatibleRelease);
      const needsDisable = !plan.compatibleRelease && plan.enabled;
      if (!needsUpdate && !needsDisable) continue;
      const backupPath = path.join(stagePath, `backup-${index}.jar`);
      await fs.move(plan.sourcePath, backupPath);
      backups.push({ sourcePath: plan.sourcePath, backupPath, finalPath: plan.finalPath });
    }

    for (const plan of plans) {
      if (plan.compatibleRelease) {
        await fs.move(plan.stagedFile, plan.finalPath);
        installedFiles.push(plan.finalPath);
      } else if (plan.enabled) {
        await fs.copy(path.join(stagePath, `backup-${plans.indexOf(plan)}.jar`), plan.finalPath);
        installedFiles.push(plan.finalPath);
      }
    }

    const updated = [];
    const disabled = [];
    for (const plan of plans) {
      if (plan.compatibleRelease) delete metadata[plan.filename];
    }
    for (const plan of plans) {
      if (plan.compatibleRelease) {
        metadata[plan.nextFilename] = {
          ...plan.info,
          title: plan.info.title || plan.nextFilename.replace(/\.jar$/i, ''),
          projectId: plan.info.projectId,
          projectVersionId: plan.compatibleRelease.id || null,
          versionNumber: plan.compatibleRelease.version_number || '',
          changelog: plan.compatibleRelease.changelog || ''
        };
        updated.push(plan.info.title || plan.filename);
      }
      if (!plan.nextEnabled) {
        disabled.push(plan.info.title || plan.filename);
      }
    }

    if (metadataExisted || updated.length) await fs.writeJson(metadataPath, metadata);
    await fs.writeJson(configPath, {
      ...config,
      version: targetVersion,
      loader,
      ...(loader === 'fabric' ? { loaderVersion } : {})
    });

    return { version: targetVersion, loaderVersion, updated, disabled };
  } catch (error) {
    for (const filePath of installedFiles.reverse()) {
      await fs.remove(filePath);
    }
    for (const backup of backups.reverse()) {
      if (await fs.pathExists(backup.backupPath)) {
        await fs.move(backup.backupPath, backup.sourcePath, { overwrite: true });
      }
    }
    if (metadataExisted) {
      await fs.writeJson(metadataPath, originalMetadata);
    } else {
      await fs.remove(metadataPath);
    }
    if (configExisted) {
      await fs.writeJson(configPath, originalConfig);
    } else {
      await fs.remove(configPath);
    }
    throw error;
  } finally {
    await fs.remove(stagePath);
  }
});
async function loadFolderAddons(instanceName, subFolder, metaFileName) {
  const instancesDir = await getInstancesDir();
  const { instancePath } = resolveInstancePath(instancesDir, instanceName);
  const targetDir = path.join(instancePath, subFolder);
  const metadataPath = path.join(instancePath, metaFileName);
  await fs.ensureDir(targetDir);

  const activeFiles = (await fs.readdir(targetDir)).filter(f => /\.(jar|zip)$/i.test(f));
  let entries = activeFiles.map(filename => ({ filename, enabled: true }));
  if (subFolder === 'mods') {
    const disabledDir = path.join(instancePath, 'disabled-mods');
    await fs.ensureDir(disabledDir);
    const disabledFiles = (await fs.readdir(disabledDir))
      .filter(f => /\.(jar|zip)$/i.test(f))
      .filter(filename => !activeFiles.includes(filename));
    entries = entries.concat(disabledFiles.map(filename => ({ filename, enabled: false })));
  }

  let metadata = {};
  if (await fs.pathExists(metadataPath)) {
    metadata = await fs.readJson(metadataPath);
  }

  if (subFolder === 'mods') {
    for (const entry of entries) {
      const info = metadata[entry.filename];
      if (info && info.managedBy === 'akari-offline-skin') {
        const folder = entry.enabled ? 'mods' : 'disabled-mods';
        hideManagedModFile(path.join(instancePath, folder, entry.filename));
      }
    }
  }

  const defaultIcon = 'https://raw.githubusercontent.com/modrinth/knights-canvas/main/static/assets/logo.png';

  const visibleEntries = entries
    .filter(({ filename }) => !(subFolder === 'mods' &&
      metadata[filename] && metadata[filename].managedBy === 'akari-offline-skin'));
  const addons = [];
  for (let index = 0; index < visibleEntries.length; index += 4) {
    const batch = visibleEntries.slice(index, index + 4);
    addons.push(...await Promise.all(batch.map(async ({ filename, enabled }) => {
      const info = metadata[filename] || {};
      let iconUrl = null;
      if (subFolder === 'mods') {
        const directory = enabled ? targetDir : path.join(instancePath, 'disabled-mods');
        try {
          iconUrl = await readModIconDataUrl(path.join(directory, filename));
        } catch (error) {
          console.warn(`Could not read icon from mod ${filename}:`, error.message);
        }
      }
      if (!iconUrl && typeof info.iconUrl === 'string' && /^https:\/\//i.test(info.iconUrl)) {
        iconUrl = info.iconUrl;
      }
      return {
        filename,
        enabled,
        title: info.title || filename.replace(/\.(jar|zip)$/, ''),
        versionNumber: info.versionNumber || '',
        projectId: info.projectId || null,
        changelog: info.changelog || 'No changelog recorded.',
        iconUrl: iconUrl || defaultIcon,
        description: info.description || filename
      };
    })));
  }
  return addons;
}

ipcMain.handle('get-mods', async (event, instanceName) => {
  return await loadFolderAddons(instanceName, 'mods', 'mods-metadata.json');
});

ipcMain.handle('get-resourcepacks', async (event, instanceName) => {
  return await loadFolderAddons(instanceName, 'resourcepacks', 'resourcepacks-metadata.json');
});

ipcMain.handle('get-shaders', async (event, instanceName) => {
  return await loadFolderAddons(instanceName, 'shaderpacks', 'shaders-metadata.json');
});

ipcMain.handle('delete-addon', async (event, { instanceName, filename, type }) => {
  const instancesDir = await getInstancesDir();
  const { instancePath } = resolveInstancePath(instancesDir, instanceName);
  if (typeof filename !== 'string' || path.basename(filename) !== filename ||
      !/^[^<>:"/\\|?*\x00-\x1f]+\.(jar|zip)$/i.test(filename)) {
    throw new Error('Invalid addon filename');
  }
  let folder = 'mods';
  let metaFile = 'mods-metadata.json';

  if (type === 'resourcepack') {
    folder = 'resourcepacks';
    metaFile = 'resourcepacks-metadata.json';
  } else if (type === 'shader') {
    folder = 'shaderpacks';
    metaFile = 'shaders-metadata.json';
  }

  let itemPath = path.join(instancePath, folder, filename);
  const metadataPath = path.join(instancePath, metaFile);
  if (type === 'mod' && !await fs.pathExists(itemPath)) {
    itemPath = path.join(instancePath, 'disabled-mods', filename);
  }

  await fs.remove(itemPath);

  if (await fs.pathExists(metadataPath)) {
    const metadata = await fs.readJson(metadataPath);
    delete metadata[filename];
    await fs.writeJson(metadataPath, metadata);
  }

  return true;
});

ipcMain.handle('search-modrinth', async (event, { query, version, loader, projectType }) => {
  try {
    const typeMap = {
      mod: 'project_type:mod',
      resourcepack: 'project_type:resourcepack',
      shader: 'project_type:shader'
    };

    const targetType = typeMap[projectType] || 'project_type:mod';
    const facetsArray = [[targetType]];

    if (version) facetsArray.push([`versions:${version}`]);
    if (projectType === 'mod' && loader && loader.toLowerCase() !== 'vanilla') {
      facetsArray.push([`categories:${loader.toLowerCase()}`]);
    }

    const response = await axios.get('https://api.modrinth.com/v2/search', {
      params: {
        query: query,
        facets: JSON.stringify(facetsArray)
      },
      headers: { 'User-Agent': 'AkariLauncher/1.0.0' }
    });

    return response.data.hits || [];
  } catch (error) {
    console.error("Modrinth search error:", error);
    return [];
  }
});

ipcMain.handle('get-addon-versions', async (event, { projectId, version, loader, projectType }) => {
  try {
    const params = {};
    if (version) params.game_versions = JSON.stringify([version]);
    if (projectType === 'mod' && loader && loader.toLowerCase() !== 'vanilla') {
      params.loaders = JSON.stringify([loader.toLowerCase()]);
    }

    const res = await axios.get(`https://api.modrinth.com/v2/project/${projectId}/version`, {
      params,
      headers: { 'User-Agent': 'AkariLauncher/1.0.0' }
    });

    return (res.data || []).map(v => ({
      id: v.id,
      name: v.name,
      version_number: v.version_number,
      changelog: v.changelog || 'No changelog provided for this version.',
      date_published: v.date_published,
      game_versions: v.game_versions,
      loaders: v.loaders
    }));
  } catch (error) {
    console.error("Failed to fetch project versions:", error.message);
    return [];
  }
});

async function downloadProjectWithDependencies(projectIdOrSlug, instanceName, projectType, targetVersion, targetLoader, specificVersionId = null, downloadedSet = new Set()) {
  const instancesDir = await getInstancesDir();
  const { name, instancePath } = resolveInstancePath(instancesDir, instanceName);

  if (!projectIdOrSlug || downloadedSet.has(projectIdOrSlug)) return;
  downloadedSet.add(projectIdOrSlug);

  try {
    let project = null;

    try {
      const projectRes = await axios.get(`https://api.modrinth.com/v2/project/${projectIdOrSlug}`, {
        headers: { 'User-Agent': 'AkariLauncher/1.0.0' }
      });
      project = projectRes.data;
    } catch (e) {
      const versionRes = await axios.get(`https://api.modrinth.com/v2/version/${projectIdOrSlug}`, {
        headers: { 'User-Agent': 'AkariLauncher/1.0.0' }
      });
      if (versionRes.data && versionRes.data.project_id) {
        return await downloadProjectWithDependencies(versionRes.data.project_id, name, projectType, targetVersion, targetLoader, null, downloadedSet);
      }
      return;
    }

    if (!project || !project.id) return;

    let selectedVersion = null;

    if (specificVersionId) {
      try {
        const verRes = await axios.get(`https://api.modrinth.com/v2/version/${specificVersionId}`, {
          headers: { 'User-Agent': 'AkariLauncher/1.0.0' }
        });
        selectedVersion = verRes.data;
      } catch (e) {
        console.error("Failed to fetch specific version, falling back to version search:", e.message);
      }
    }

    if (!selectedVersion) {
      const params = {};
      if (targetVersion) params.game_versions = JSON.stringify([targetVersion]);
      if (projectType === 'mod' && targetLoader && targetLoader.toLowerCase() !== 'vanilla') {
        params.loaders = JSON.stringify([targetLoader.toLowerCase()]);
      }

      const versionsRes = await axios.get(`https://api.modrinth.com/v2/project/${project.id}/version`, {
        params,
        headers: { 'User-Agent': 'AkariLauncher/1.0.0' }
      });

      const availableVersions = versionsRes.data;
      if (!availableVersions || availableVersions.length === 0) return;
      selectedVersion = availableVersions[0];
    }

    if (!selectedVersion || !Array.isArray(selectedVersion.files) || selectedVersion.files.length === 0) return;

    const primaryFile = selectedVersion.files.find(f => f && f.primary) || selectedVersion.files[0];
    if (!primaryFile || !primaryFile.url) return;
    if (typeof primaryFile.filename !== 'string' ||
        path.basename(primaryFile.filename) !== primaryFile.filename ||
        !/^[^<>:"/\\|?*\x00-\x1f]+\.(jar|zip)$/i.test(primaryFile.filename)) {
      throw new Error('Modrinth returned an invalid addon filename');
    }

    let subFolder = 'mods';
    let metaFile = 'mods-metadata.json';
    if (projectType === 'resourcepack') {
      subFolder = 'resourcepacks';
      metaFile = 'resourcepacks-metadata.json';
    } else if (projectType === 'shader') {
      subFolder = 'shaderpacks';
      metaFile = 'shaders-metadata.json';
    }

    const destDir = path.join(instancePath, subFolder);
    await fs.ensureDir(destDir);

    const filePath = path.join(destDir, primaryFile.filename);
    const metadataPath = path.join(instancePath, metaFile);

    const fileRes = await axios.get(primaryFile.url, { responseType: 'arraybuffer' });
    await fs.writeFile(filePath, Buffer.from(fileRes.data));

    let metadata = {};
    if (await fs.pathExists(metadataPath)) {
      metadata = await fs.readJson(metadataPath);
    }

    metadata[primaryFile.filename] = {
      title: project.title || primaryFile.filename,
      versionNumber: selectedVersion.version_number || '',
      projectId: project.id,
      projectVersionId: selectedVersion.id || null,
      changelog: selectedVersion.changelog || 'No changelog provided.',
      iconUrl: project.icon_url || 'https://raw.githubusercontent.com/modrinth/knights-canvas/main/static/assets/logo.png',
      description: project.description || ''
    };
    await fs.writeJson(metadataPath, metadata);

    if (Array.isArray(selectedVersion.dependencies)) {
      for (const dep of selectedVersion.dependencies) {
        if (dep && dep.dependency_type === 'required') {
          const depIdentifier = dep.project_id || dep.version_id;
          if (depIdentifier) {
            try {
              await downloadProjectWithDependencies(
                depIdentifier, 
                name, 
                projectType, 
                targetVersion, 
                targetLoader, 
                null, 
                downloadedSet
              );
            } catch (depErr) {
              console.error(`Failed to download dependency ${depIdentifier}:`, depErr.message);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error(`Error downloading project ${projectIdOrSlug}:`, err.message);
    throw err;
  }
}

ipcMain.handle('download-addon', async (event, payload) => {
  try {
    const instancesDir = await getInstancesDir();
    const { name: cleanInstanceName, instancePath } = resolveInstancePath(instancesDir, payload.instanceName);
    const project = payload.project;
    const projectType = payload.projectType;
    const specificVersionId = payload.versionId || null;

    const configFile = path.join(instancePath, 'config.json');
    let version = '1.20.1';
    let loader = 'vanilla';

    if (await fs.pathExists(configFile)) {
      const config = await fs.readJson(configFile);
      version = config.version || version;
      loader = config.loader || loader;
    }

    if (projectType === 'mod' && String(loader).toLowerCase() === 'vanilla') {
      sendLogToWindows('[ERROR] Cannot install mods into a Vanilla instance. Create a Fabric, Forge, or NeoForge instance first.\n');
      return false;
    }

    const projectId = project.project_id || project.id || project.slug;
    await downloadProjectWithDependencies(projectId, cleanInstanceName, projectType, version, loader, specificVersionId);
    return true;
  } catch (error) {
    console.error("Download Addon Error:", error);
    return false;
  }
});

async function resolveOfflineSkinUrl(mode, value) {
  if (mode === 'url') return value;
  if (mode !== 'mojang' || !isValidOfflineUsername(value)) {
    throw new Error('Choose a valid HTTPS skin URL or Mojang username.');
  }

  const profileResponse = await axios.get(
    `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(value)}`,
    { timeout: 15000, headers: { 'User-Agent': 'AkariLauncher/1.0.0' } }
  );
  if (!profileResponse.data || !/^[a-f0-9]{32}$/i.test(profileResponse.data.id || '')) {
    throw new Error(`Could not find the Mojang profile "${value}".`);
  }

  const sessionResponse = await axios.get(
    `https://sessionserver.mojang.com/session/minecraft/profile/${profileResponse.data.id}?unsigned=false`,
    { timeout: 15000, headers: { 'User-Agent': 'AkariLauncher/1.0.0' } }
  );
  const textureProperty = (sessionResponse.data && sessionResponse.data.properties || [])
    .find(property => property && property.name === 'textures' && typeof property.value === 'string');
  if (!textureProperty) throw new Error(`No skin is set for Mojang profile "${value}".`);

  let textureData;
  try {
    textureData = JSON.parse(Buffer.from(textureProperty.value, 'base64').toString('utf8'));
  } catch {
    throw new Error('Mojang returned invalid skin profile data.');
  }
  const skinUrl = textureData && textureData.textures && textureData.textures.SKIN &&
    textureData.textures.SKIN.url;
  let parsedSkinUrl;
  try {
    parsedSkinUrl = new URL(skinUrl);
  } catch {
    throw new Error(`No skin is set for Mojang profile "${value}".`);
  }
  if (!['http:', 'https:'].includes(parsedSkinUrl.protocol) ||
      parsedSkinUrl.hostname !== 'textures.minecraft.net' ||
      parsedSkinUrl.username || parsedSkinUrl.password) {
    throw new Error('Mojang returned an unexpected skin URL.');
  }
  parsedSkinUrl.protocol = 'https:';
  return parsedSkinUrl.toString();
}

async function installCustomSkinLoader(instancePath, minecraftVersion, loader) {
  const supportedLoaders = ['fabric', 'forge', 'neoforge'];
  if (!supportedLoaders.includes(loader)) {
    throw new Error('Custom offline skins require a Fabric, Forge, or NeoForge instance. Vanilla instances are not supported.');
  }

  const response = await axios.get(
    `https://api.modrinth.com/v2/project/${CUSTOM_SKINLOADER_PROJECT_ID}/version`,
    {
      params: {
        game_versions: JSON.stringify([minecraftVersion]),
        loaders: JSON.stringify([loader])
      },
      timeout: 20000,
      headers: { 'User-Agent': 'AkariLauncher/1.0.0' }
    }
  );
  const release = (response.data || []).find(item =>
    item && Array.isArray(item.game_versions) &&
    item.game_versions.includes(minecraftVersion) &&
    Array.isArray(item.loaders) && item.loaders.includes(loader) &&
    typeof item.id === 'string' && /^[A-Za-z0-9]+$/.test(item.id)
  );
  const file = release && Array.isArray(release.files)
    ? release.files.find(candidate => candidate && candidate.primary) || release.files[0]
    : null;
  let modUrl;
  try {
    modUrl = new URL(file && file.url);
  } catch {
    throw new Error(`CustomSkinLoader has no compatible release for Minecraft ${minecraftVersion} (${loader}).`);
  }
  if (modUrl.protocol !== 'https:' || modUrl.hostname !== 'cdn.modrinth.com' ||
      typeof file.filename !== 'string' || !/^[^<>:"/\\|?*\x00-\x1f]+\.jar$/i.test(file.filename) ||
      !file.hashes || !/^[a-f0-9]{128}$/i.test(file.hashes.sha512 || '')) {
    throw new Error('Modrinth returned an invalid CustomSkinLoader download.');
  }

  const instancesDir = await getInstancesDir();
  const { instancePath: safeInstancePath } = resolveInstancePath(instancesDir, path.basename(instancePath));
  if (safeInstancePath !== path.resolve(instancePath)) {
    throw new Error('Invalid instance path for CustomSkinLoader installation.');
  }
  const modsPath = path.join(instancePath, 'mods');
  const disabledModsPath = path.join(instancePath, 'disabled-mods');
  const metadataPath = path.join(instancePath, 'mods-metadata.json');
  await fs.ensureDir(modsPath);
  const metadata = await fs.pathExists(metadataPath) ? await fs.readJson(metadataPath) : {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Invalid mods metadata file');
  }

  const filename = `akari-customskinloader-${release.id}.jar`;
  const targetPath = path.join(modsPath, filename);
  const disabledTargetPath = path.join(disabledModsPath, filename);
  const existingInfo = metadata[filename];
  let installedNewFile = false;
  let movedFromDisabled = false;
  if (await fs.pathExists(targetPath)) {
    if (!existingInfo || existingInfo.managedBy !== 'akari-offline-skin') {
      throw new Error(`Cannot install CustomSkinLoader because "${filename}" already exists and is not managed by Akari.`);
    }
  } else if (await fs.pathExists(disabledTargetPath)) {
    if (!existingInfo || existingInfo.managedBy !== 'akari-offline-skin') {
      throw new Error(`Cannot install CustomSkinLoader because "${filename}" exists in disabled mods and is not managed by Akari.`);
    }
    await fs.ensureDir(modsPath);
    await fs.move(disabledTargetPath, targetPath);
    installedNewFile = true;
    movedFromDisabled = true;
  } else {
    const download = await axios.get(file.url, {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: 20 * 1024 * 1024,
      headers: { 'User-Agent': 'AkariLauncher/1.0.0' }
    });
    const bytes = Buffer.from(download.data);
    if (bytes.length !== file.size ||
        crypto.createHash('sha512').update(bytes).digest('hex').toLowerCase() !== file.hashes.sha512.toLowerCase()) {
      throw new Error('CustomSkinLoader download failed its integrity check.');
    }
    const stagingPath = await fs.mkdtemp(path.join(instancePath, '.akari-skin-'));
    try {
      const stagedFile = path.join(stagingPath, filename);
      await fs.writeFile(stagedFile, bytes, { flag: 'wx' });
      await fs.move(stagedFile, targetPath);
      installedNewFile = true;
    } finally {
      await fs.remove(stagingPath);
    }
  }

  const nextMetadata = { ...metadata };
  for (const [oldFilename, info] of Object.entries(nextMetadata)) {
    if (oldFilename !== filename && info && info.managedBy === 'akari-offline-skin') {
      await fs.remove(path.join(modsPath, oldFilename));
      await fs.remove(path.join(disabledModsPath, oldFilename));
      delete nextMetadata[oldFilename];
    }
  }
  nextMetadata[filename] = {
    title: 'CustomSkinLoader (Akari offline skin support)',
    projectId: CUSTOM_SKINLOADER_PROJECT_ID,
    projectVersionId: release.id,
    versionNumber: release.version_number || '',
    iconUrl: `https://cdn.modrinth.com/data/${CUSTOM_SKINLOADER_PROJECT_ID}/icon.png`,
    description: 'Installed by Akari Launcher for custom offline skins.',
    managedBy: 'akari-offline-skin'
  };
  try {
    hideManagedModFile(targetPath);
    await fs.writeJson(metadataPath, nextMetadata);
  } catch (error) {
    if (movedFromDisabled) {
      await fs.ensureDir(disabledModsPath);
      await fs.move(targetPath, disabledTargetPath);
    } else if (installedNewFile) {
      await fs.remove(targetPath);
    }
    throw error;
  }
}

async function updateCustomSkinLoaderProfile(instancePath, skinUrl, username) {
  const dataPath = path.join(instancePath, 'CustomSkinLoader');
  const configPath = path.join(dataPath, 'CustomSkinLoader.json');
  const extraListPath = path.join(dataPath, 'ExtraList', 'AkariLauncherOfflineSkin.json');
  const skinPath = path.join(dataPath, 'AkariLauncherOfflineSkin', 'skins', `${username}.png`);
  const isEnabled = Boolean(skinUrl);
  const profile = {
    name: OFFLINE_SKIN_PROFILE_NAME,
    type: 'Legacy',
    skin: OFFLINE_SKIN_PROFILE_PATH,
    model: 'auto',
    checkPNG: false
  };

  if (isEnabled) {
    if (!isValidOfflineUsername(username)) {
      throw new Error('Cannot configure an offline skin for an invalid username.');
    }
    const response = await axios.get(skinUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      maxContentLength: 2 * 1024 * 1024
    });
    const skinBytes = Buffer.from(response.data);
    const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
    if (skinBytes.length < pngSignature.length ||
        !skinBytes.subarray(0, pngSignature.length).equals(pngSignature)) {
      throw new Error('Mojang returned an invalid skin image.');
    }
    await fs.ensureDir(path.dirname(skinPath));
    await fs.writeFile(skinPath, skinBytes);
  } else {
    await fs.remove(skinPath);
  }

  if (await fs.pathExists(configPath)) {
    let config;
    try {
      config = await fs.readJson(configPath);
    } catch (error) {
      if (isEnabled) throw new Error(`Could not read CustomSkinLoader config: ${error.message}`);
      console.warn('Could not read CustomSkinLoader config while clearing Akari skin settings:', error.message);
      await fs.remove(extraListPath);
      return;
    }
    if (!config || typeof config !== 'object' || Array.isArray(config) ||
        !Array.isArray(config.loadlist)) {
      if (isEnabled) throw new Error('CustomSkinLoader has an invalid config file; it was left unchanged.');
      console.warn('CustomSkinLoader has an invalid config file; leaving it unchanged.');
      await fs.remove(extraListPath);
      return;
    }
    const existingIndex = config.loadlist.findIndex(item =>
      item && item.name === OFFLINE_SKIN_PROFILE_NAME
    );
    let changed = false;
    if (isEnabled) {
      if (existingIndex >= 0) {
        const updatedProfile = { ...config.loadlist[existingIndex], ...profile };
        changed = JSON.stringify(updatedProfile) !== JSON.stringify(config.loadlist[existingIndex]);
        config.loadlist[existingIndex] = updatedProfile;
      } else {
        config.loadlist.unshift(profile);
        changed = true;
      }
    } else if (existingIndex >= 0) {
      config.loadlist = config.loadlist.filter(item =>
        !item || item.name !== OFFLINE_SKIN_PROFILE_NAME
      );
      changed = true;
    }
    if (changed) await fs.writeJson(configPath, config);
    await fs.remove(extraListPath);
    return;
  }

  if (isEnabled) {
    await fs.ensureDir(path.dirname(extraListPath));
    await fs.writeJson(extraListPath, profile);
  } else {
    await fs.remove(extraListPath);
  }
}

ipcMain.handle('launch-instance', async (event, instanceName) => {
  // Automatically open or focus game logs window on boot
  createLogsWindow();

  const settings = await readAppSettings();
  const offlineMode = settings.launchMode === 'offline';
  if (!offlineMode && !userAuth) {
    sendLogToWindows("[ERROR] Please log in with Microsoft first!\n");
    return 'Please log in first!';
  }
  if (offlineMode && !isValidOfflineUsername(settings.offlineUsername)) {
    sendLogToWindows('[ERROR] Set a valid offline username in Settings before launching.\n');
    return 'Set a valid offline username in Settings before launching.';
  }

  const instancesDir = await getInstancesDir();
  const { name, instancePath: instanceRoot } = resolveInstancePath(instancesDir, instanceName);
  const configFile = path.join(instanceRoot, 'config.json');
  
  let version = '1.20.1';
  let loader = 'vanilla';
  let savedNeoVersion = null;
  let savedLoaderVersion = null;
  let memory = normalizeMemorySettings();

  if (await fs.pathExists(configFile)) {
    const config = await fs.readJson(configFile);
    version = config.version || version;
    loader = config.loader || loader;
    savedNeoVersion = config.neoforgeVersion || null;
    savedLoaderVersion = config.loaderVersion || null;
    memory = normalizeMemorySettings(config.memory);
  }

  const selectedLoader = loader.toLowerCase();
  try {
    let offlineSkinUrl = null;
    if (offlineMode && settings.offlineSkinMode !== 'none') {
      offlineSkinUrl = await resolveOfflineSkinUrl(settings.offlineSkinMode, settings.offlineSkinValue);
      await installCustomSkinLoader(instanceRoot, version, selectedLoader);
    }
    await updateCustomSkinLoaderProfile(instanceRoot, offlineSkinUrl, settings.offlineUsername);
    if (offlineSkinUrl) {
      sendLogToWindows('[INFO] Custom offline skin configured for this instance.\n');
    }
  } catch (error) {
    sendLogToWindows(`[ERROR] Offline skin setup failed: ${error.message}\n`);
    return `Offline skin setup failed: ${error.message}`;
  }

  sendLogToWindows(`\n=== Starting Launch Sequence for ${name} (${version} - ${selectedLoader.toUpperCase()}) ===\n`);

  const launcher = new Client();

  const opts = {
    authorization: offlineMode ? Authenticator.getAuth(settings.offlineUsername) : userAuth,
    root: instanceRoot,
    version: {
      number: version,
      type: 'release'
    },
    memory: {
      max: `${memory.max}G`,
      min: `${memory.min}G`
    },
    timeout: 120000
  };

  sendLogToWindows(offlineMode
    ? `[INFO] Launching in offline mode as ${settings.offlineUsername}. Online-mode servers require Microsoft authentication.\n`
    : '[INFO] Launching with Microsoft authentication.\n');

  try {
    const javaRuntime = await resolveMinecraftJava(version);
    opts.javaPath = javaRuntime.javaPath;
    sendLogToWindows(`[INFO] Using Java ${javaRuntime.majorVersion} for Minecraft ${version}.\n`);
  } catch (error) {
    sendLogToWindows(`[ERROR] Could not prepare Java for Minecraft ${version}: ${error.message}\n`);
    return `Could not prepare Java for Minecraft ${version}: ${error.message}`;
  }

  if (selectedLoader === 'fabric') {
    try {
      sendLogToWindows("[INFO] Fetching Fabric loader profile...\n");

      const loaderRes = await axios.get(`https://meta.fabricmc.net/v2/versions/loader/${version}`, {
        headers: { 'User-Agent': 'AkariLauncher/1.0.0' }
      });

      if (!loaderRes.data || loaderRes.data.length === 0) {
        throw new Error(`No Fabric loader available for Minecraft ${version}`);
      }

      const loaderVersion = savedLoaderVersion || loaderRes.data[0].loader.version;

      const profileRes = await axios.get(
        `https://meta.fabricmc.net/v2/versions/loader/${version}/${loaderVersion}/profile/json`,
        { headers: { 'User-Agent': 'AkariLauncher/1.0.0' } }
      );

      const customVersionName = `fabric-loader-${loaderVersion}-${version}`;
      const versionDir = path.join(instanceRoot, 'versions', customVersionName);
      const versionJsonPath = path.join(versionDir, `${customVersionName}.json`);

      await fs.ensureDir(versionDir);
      await fs.writeJson(versionJsonPath, profileRes.data);

      opts.version.custom = customVersionName;
      sendLogToWindows(`[INFO] Fabric loader ${loaderVersion} profile set successfully.\n`);
    } catch (err) {
      sendLogToWindows(`[ERROR] Failed to setup Fabric: ${err.message}\n`);
      return `Fabric Setup Failed: ${err.message}`;
    }
  } 
  else if (selectedLoader === 'forge') {
    try {
      sendLogToWindows("[INFO] Fetching Forge version manifest...\n");
      
      const forgePromotions = await axios.get('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json', {
        headers: { 'User-Agent': 'AkariLauncher/1.0.0' }
      });

      const promos = forgePromotions.data.promos || {};
      const forgeVersionNum = promos[`${version}-recommended`] || promos[`${version}-latest`];

      if (!forgeVersionNum) {
        throw new Error(`No Forge build found for Minecraft ${version}`);
      }

      const fullForgeVersion = `${version}-${forgeVersionNum}`;
      sendLogToWindows(`[INFO] Selected Forge version: ${fullForgeVersion}\n`);

      const installerName = `forge-${fullForgeVersion}-installer.jar`;
      const installerPath = path.join(instanceRoot, installerName);

      if (!await fs.pathExists(installerPath)) {
        sendLogToWindows(`[INFO] Downloading Forge installer...\n`);
        const downloadUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${fullForgeVersion}/${installerName}`;
        const jarRes = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
        await fs.writeFile(installerPath, Buffer.from(jarRes.data));
      }

      if (compareMinecraftVersions(version, '26.0') >= 0) {
        const customVersionName = `${version}-forge-${forgeVersionNum}`;
        const versionDir = path.join(instanceRoot, 'versions', customVersionName);
        const installedJsonPath = path.join(versionDir, `${customVersionName}.json`);
        if (!await fs.pathExists(installedJsonPath)) {
          const profilesPath = path.join(instanceRoot, 'launcher_profiles.json');
          if (!await fs.pathExists(profilesPath)) {
            await fs.writeJson(profilesPath, { profiles: {} });
          }
          sendLogToWindows('[INFO] Installing Forge client profile...\n');
          execFileSync(opts.javaPath, ['-jar', installerPath, '--installClient', instanceRoot], {
            cwd: instanceRoot,
            stdio: 'pipe',
            windowsHide: true
          });
        }
        if (!await fs.pathExists(installedJsonPath)) {
          throw new Error(`Forge installer did not create the ${customVersionName} profile.`);
        }
        const forgeJson = await fs.readJson(installedJsonPath);
        opts.version.custom = customVersionName;
        opts.customArgs = (forgeJson.arguments && Array.isArray(forgeJson.arguments.jvm)
          ? forgeJson.arguments.jvm
          : [])
          .filter(arg => typeof arg === 'string')
          .map(arg => arg
            .replace(/\${library_directory}/g, path.join(instanceRoot, 'libraries'))
            .replace(/\${classpath_separator}/g, path.delimiter)
            .replace(/\${version_name}/g, version));
      } else {
        opts.forge = installerPath;
      }
      sendLogToWindows(`[INFO] Forge installer configured successfully.\n`);
    } catch (err) {
      sendLogToWindows(`[ERROR] Failed to setup Forge: ${err.message}\n`);
      return `Forge Setup Failed: ${err.message}`;
    }
  } 
  else if (selectedLoader === 'neoforge') {
    try {
      let targetNeoVersion = savedNeoVersion;

      if (!targetNeoVersion) {
        sendLogToWindows("[INFO] Fetching NeoForge releases...\n");
        
        const mavenRes = await axios.get('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge', {
          headers: { 'User-Agent': 'AkariLauncher/1.0.0' }
        });

        const versions = mavenRes.data.versions || [];
        const targetPrefix = getNeoForgeVersionPrefix(version);
        if (!targetPrefix) {
          throw new Error(`Invalid Minecraft version for NeoForge: ${version}`);
        }

        const validVersions = versions.filter(v => v.startsWith(targetPrefix));

        if (validVersions.length === 0) {
          throw new Error(`No NeoForge version available for Minecraft ${version} (Prefix: ${targetPrefix})`);
        }

        targetNeoVersion = validVersions[validVersions.length - 1];
      }

      const targetPrefix = getNeoForgeVersionPrefix(version);
      if (!targetPrefix || !targetNeoVersion.startsWith(targetPrefix)) {
        throw new Error(`NeoForge ${targetNeoVersion} does not support Minecraft ${version}.`);
      }

      sendLogToWindows(`[INFO] Selected NeoForge target: ${targetNeoVersion} for MC ${version}\n`);

      const customVersionName = `neoforge-${targetNeoVersion}`;
      const versionDir = path.join(instanceRoot, 'versions', customVersionName);
      const installedJsonPath = path.join(versionDir, `${customVersionName}.json`);

      if (!await fs.pathExists(installedJsonPath)) {
        const installerName = `neoforge-${targetNeoVersion}-installer.jar`;
        const installerPath = path.join(instanceRoot, installerName);

        if (!await fs.pathExists(installerPath)) {
          sendLogToWindows(`[INFO] Downloading NeoForge installer (${targetNeoVersion})...\n`);
          const downloadUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${targetNeoVersion}/${installerName}`;
          const jarRes = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
          await fs.writeFile(installerPath, Buffer.from(jarRes.data));
        }

        const profilesPath = path.join(instanceRoot, 'launcher_profiles.json');
        if (!await fs.pathExists(profilesPath)) {
          await fs.writeJson(profilesPath, { profiles: {} });
        }

        sendLogToWindows(`[INFO] Extracting NeoForge dependencies...\n`);
        execFileSync(opts.javaPath, ['-jar', installerPath, '--install-client', instanceRoot], {
          cwd: instanceRoot,
          stdio: 'pipe',
          windowsHide: true
        });
      }

      if (await fs.pathExists(installedJsonPath)) {
        const neoJson = await fs.readJson(installedJsonPath);

        opts.version.custom = customVersionName;

        const extraArgs = [];
        const librariesDir = path.join(instanceRoot, 'libraries');

        if (neoJson.arguments && Array.isArray(neoJson.arguments.jvm)) {
          for (let arg of neoJson.arguments.jvm) {
            if (typeof arg === 'string') {
              const resolved = arg
                .replace(/\${library_directory}/g, librariesDir)
                .replace(/\${classpath_separator}/g, path.delimiter)
                .replace(/\${version_name}/g, version);
              extraArgs.push(resolved);
            }
          }
        }

        opts.customArgs = extraArgs;
      } else {
        throw new Error("NeoForge installation failed to produce custom version JSON.");
      }

      sendLogToWindows(`[INFO] NeoForge setup completed successfully.\n`);
    } catch (err) {
      const errorDetails = err.stderr ? err.stderr.toString() : err.message;
      sendLogToWindows(`[ERROR] Failed to setup NeoForge: ${errorDetails}\n`);
      return `NeoForge Setup Failed: ${errorDetails}`;
    }
  }

  let lastProgress = -1;
  let lastType = '';

  launcher.on('data', (e) => sendLogToWindows(`[GAME] ${e.toString()}\n`));
  launcher.on('progress', (e) => {
    const percent = Math.round((e.task / e.total) * 100);
    if (percent !== lastProgress || e.type !== lastType) {
      lastProgress = percent;
      lastType = e.type;
      sendLogToWindows(`[PROGRESS] ${e.type}: ${percent}%\n`);
    }
  });
  launcher.on('debug', (e) => sendLogToWindows(`[DEBUG] ${e.toString()}\n`));
  launcher.on('close', (code) => {
    sendLogToWindows(`[INFO] Game process exited with code ${code}\n`);
    const runningIndex = discordPlayingInstances.lastIndexOf(name);
    if (runningIndex >= 0) {
      discordPlayingInstances.splice(runningIndex, 1);
      void updateDiscordPresenceActivity().catch(error => {
        console.warn('Could not update Discord Rich Presence after Minecraft closed:', error.message);
      });
    }
  });
  launcher.on('error', (err) => {
    console.error("Launcher Error:", err);
    sendLogToWindows(`[ERROR] Launch Failed: ${err.message || err}\n`);
  });

  try {
    await launcher.launch(opts);
    discordPlayingInstances.push(name);
    void updateDiscordPresenceActivity().catch(error => {
      console.warn('Could not update Discord Rich Presence for the running instance:', error.message);
    });
    return `Launching ${name}...`;
  } catch (err) {
    console.error("Launch Exception:", err);
    sendLogToWindows(`[CRITICAL ERROR] ${err.stack || err.message || err}\n`);
    return `Failed to launch: ${err.message}`;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});