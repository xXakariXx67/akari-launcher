const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const { Auth } = require('msmc');
const { Client } = require('minecraft-launcher-core');
const { execSync } = require('child_process');

let mainWindow;
let logsWindow = null;
let userAuth = null;

const defaultDataPath = path.join(app.getPath('userData'), 'instances');
const authFile = path.join(app.getPath('userData'), 'auth.json');
const settingsFile = path.join(app.getPath('userData'), 'settings.json');

const appIconPath = path.resolve(__dirname, 'icon', 'akari-launcher.png');

//const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const { autoUpdater } = require('electron-updater'); // <-- ADD THIS
//const path = require('path');

// ... (your existing main.js imports and functions) ...

app.whenReady().then(async () => {
  const instancesDir = await getInstancesDir();
  await fs.ensureDir(instancesDir);
  createWindow();

  // Automatically check for updates on startup
  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.error("Update check failed:", err);
  });
});

const DEFAULT_VERSIONS = [
  '1.21.1', '1.21', '1.20.6', '1.20.4', '1.20.2', '1.20.1',
  '1.19.4', '1.19.2', '1.18.2', '1.17.1', '1.16.5', '1.12.2', '1.8.9'
];

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
    const versions = res.data.versions.filter(v => v.type === 'release').map(v => v.id);
    return versions.length > 0 ? versions : DEFAULT_VERSIONS;
  } catch (error) {
    console.error('Failed to fetch MC versions, using default list:', error.message);
    return DEFAULT_VERSIONS;
  }
});

ipcMain.handle('get-neoforge-versions', async (event, mcVersion) => {
  try {
    const mavenRes = await axios.get('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge', {
      headers: { 'User-Agent': 'AkariLauncher/1.0.0' }
    });

    const versions = mavenRes.data.versions || [];

    let targetPrefix = '';
    if (mcVersion === '1.20.1') {
      targetPrefix = '47.1.';
    } else {
      const parts = mcVersion.split('.');
      if (parts.length >= 2) {
        const major = parts[1];
        const minor = parts[2] || '0';
        targetPrefix = `${major}.${minor}.`;
      }
    }

    return versions.filter(v => v.startsWith(targetPrefix)).reverse();
  } catch (err) {
    console.error("Failed to fetch NeoForge versions:", err.message);
    return [];
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

  const modsPath = path.join(instancePath, 'mods');
  const resourcepacksPath = path.join(instancePath, 'resourcepacks');
  const shaderpacksPath = path.join(instancePath, 'shaderpacks');
  const configFile = path.join(instancePath, 'config.json');

  await fs.ensureDir(modsPath);
  await fs.ensureDir(resourcepacksPath);
  await fs.ensureDir(shaderpacksPath);

  await fs.writeJson(configFile, { version, loader, neoforgeVersion });
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

async function loadFolderAddons(instanceName, subFolder, metaFileName) {
  const instancesDir = await getInstancesDir();
  const { instancePath } = resolveInstancePath(instancesDir, instanceName);
  const targetDir = path.join(instancePath, subFolder);
  const metadataPath = path.join(instancePath, metaFileName);
  await fs.ensureDir(targetDir);

  const files = await fs.readdir(targetDir);
  const validFiles = files.filter(f => f.endsWith('.jar') || f.endsWith('.zip'));

  let metadata = {};
  if (await fs.pathExists(metadataPath)) {
    metadata = await fs.readJson(metadataPath);
  }

  const defaultIcon = 'https://raw.githubusercontent.com/modrinth/knights-canvas/main/static/assets/logo.png';

  return validFiles.map(filename => {
    const info = metadata[filename] || {};
    return {
      filename,
      title: info.title || filename.replace(/\.(jar|zip)$/, ''),
      versionNumber: info.versionNumber || '',
      changelog: info.changelog || 'No changelog recorded.',
      iconUrl: (info.iconUrl && info.iconUrl.startsWith('http')) ? info.iconUrl : defaultIcon,
      description: info.description || filename
    };
  });
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

  const itemPath = path.join(instancePath, folder, filename);
  const metadataPath = path.join(instancePath, metaFile);

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

    const projectId = project.project_id || project.id || project.slug;
    await downloadProjectWithDependencies(projectId, cleanInstanceName, projectType, version, loader, specificVersionId);
    return true;
  } catch (error) {
    console.error("Download Addon Error:", error);
    return false;
  }
});

ipcMain.handle('launch-instance', async (event, instanceName) => {
  // Automatically open or focus game logs window on boot
  createLogsWindow();

  if (!userAuth) {
    sendLogToWindows("[ERROR] Please log in with Microsoft first!\n");
    return 'Please log in first!';
  }

  const instancesDir = await getInstancesDir();
  const { name, instancePath: instanceRoot } = resolveInstancePath(instancesDir, instanceName);
  const configFile = path.join(instanceRoot, 'config.json');
  
  let version = '1.20.1';
  let loader = 'vanilla';
  let savedNeoVersion = null;

  if (await fs.pathExists(configFile)) {
    const config = await fs.readJson(configFile);
    version = config.version || version;
    loader = config.loader || loader;
    savedNeoVersion = config.neoforgeVersion || null;
  }

  const selectedLoader = loader.toLowerCase();
  sendLogToWindows(`\n=== Starting Launch Sequence for ${name} (${version} - ${selectedLoader.toUpperCase()}) ===\n`);

  const launcher = new Client();

  const opts = {
    authorization: userAuth,
    root: instanceRoot,
    version: {
      number: version,
      type: 'release'
    },
    memory: {
      max: '4G',
      min: '2G'
    }
  };

  if (selectedLoader === 'fabric') {
    try {
      sendLogToWindows("[INFO] Fetching Fabric loader profile...\n");

      const loaderRes = await axios.get(`https://meta.fabricmc.net/v2/versions/loader/${version}`, {
        headers: { 'User-Agent': 'AkariLauncher/1.0.0' }
      });

      if (!loaderRes.data || loaderRes.data.length === 0) {
        throw new Error(`No Fabric loader available for Minecraft ${version}`);
      }

      const loaderVersion = loaderRes.data[0].loader.version;

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

      opts.forge = installerPath;
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
        
        let targetPrefix = '';
        if (version === '1.20.1') {
          targetPrefix = '47.1.';
        } else {
          const parts = version.split('.');
          if (parts.length >= 2) {
            const major = parts[1];
            const minor = parts[2] || '0';
            targetPrefix = `${major}.${minor}.`;
          }
        }

        const validVersions = versions.filter(v => v.startsWith(targetPrefix));

        if (validVersions.length === 0) {
          throw new Error(`No NeoForge version available for Minecraft ${version} (Prefix: ${targetPrefix})`);
        }

        targetNeoVersion = validVersions[validVersions.length - 1];
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
        execSync(`java -jar "${installerPath}" --install-client "${instanceRoot}"`, { cwd: instanceRoot, stdio: 'pipe' });
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
  launcher.on('close', (code) => sendLogToWindows(`[INFO] Game process exited with code ${code}\n`));
  launcher.on('error', (err) => {
    console.error("Launcher Error:", err);
    sendLogToWindows(`[ERROR] Launch Failed: ${err.message || err}\n`);
  });

  try {
    await launcher.launch(opts);
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