const yauzl = require('@xmcl/yauzl');
const path = require('path');

const MAX_ARCHIVE_ENTRIES = 50000;
const MAX_METADATA_SIZE = 512 * 1024;
const MAX_ICON_SIZE = 2 * 1024 * 1024;
const MOD_METADATA_FILES = [
  'fabric.mod.json',
  'quilt.mod.json',
  'meta-inf/mods.toml',
  'meta-inf/neoforge.mods.toml',
  'mcmod.info'
];

function openArchive(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, {
      lazyEntries: true,
      autoClose: false,
      validateEntrySizes: true,
      strictFileNames: true
    }, (error, archive) => {
      if (error) reject(error);
      else resolve(archive);
    });
  });
}

function listEntries(archive) {
  return new Promise((resolve, reject) => {
    const entries = new Map();
    let count = 0;
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    archive.on('error', fail);
    archive.on('entry', entry => {
      if (++count > MAX_ARCHIVE_ENTRIES) {
        fail(new Error(`Mod archive contains more than ${MAX_ARCHIVE_ENTRIES} entries`));
        archive.close();
        return;
      }
      const name = entry.fileName.replace(/\\/g, '/');
      if (name && !name.endsWith('/')) entries.set(name.toLowerCase(), entry);
      archive.readEntry();
    });
    archive.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(entries);
    });
    archive.readEntry();
  });
}

function readEntry(archive, entry, maxSize) {
  if (entry.uncompressedSize > maxSize) {
    return Promise.reject(new Error(`Mod archive entry exceeds the ${maxSize}-byte read limit`));
  }
  return new Promise((resolve, reject) => {
    archive.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      const chunks = [];
      let size = 0;
      let settled = false;
      const fail = readError => {
        if (settled) return;
        settled = true;
        reject(readError);
      };
      stream.on('data', chunk => {
        size += chunk.length;
        if (size > maxSize) {
          stream.destroy();
          fail(new Error(`Mod archive entry exceeds the ${maxSize}-byte read limit`));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('error', fail);
      stream.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks, size));
      });
    });
  });
}

function getIconPath(metadataName, metadata) {
  if (metadataName === 'fabric.mod.json') {
    const icon = metadata && metadata.icon;
    if (typeof icon === 'string') return icon;
    if (icon && typeof icon === 'object' && !Array.isArray(icon)) {
      const sizes = Object.keys(icon).sort((left, right) => Number(right) - Number(left));
      return sizes.map(size => icon[size]).find(value => typeof value === 'string') || null;
    }
  }

  if (metadataName === 'quilt.mod.json') {
    const icon = metadata && metadata.quilt_loader &&
      metadata.quilt_loader.metadata && metadata.quilt_loader.metadata.icon;
    if (typeof icon === 'string') return icon;
    if (icon && typeof icon === 'object' && !Array.isArray(icon)) {
      const sizes = Object.keys(icon).sort((left, right) => Number(right) - Number(left));
      return sizes.map(size => icon[size]).find(value => typeof value === 'string') || null;
    }
  }

  if (metadataName === 'mcmod.info') {
    const mod = Array.isArray(metadata) ? metadata[0] : metadata;
    return mod && (mod.logoFile || mod.logo) || null;
  }

  if (metadataName.endsWith('.toml')) {
    const firstMod = metadata.match(/\[\[mods\]\]([\s\S]*?)(?=\n\s*\[\[|\s*$)/i);
    const section = firstMod ? firstMod[1] : metadata;
    const icon = /^\s*logoFile\s*=\s*["']([^"']+)["']/im.exec(section);
    return icon ? icon[1] : null;
  }

  return null;
}

function normalizeIconPath(iconPath) {
  if (typeof iconPath !== 'string' || !iconPath.trim()) return null;
  const normalized = path.posix.normalize(iconPath.trim().replace(/\\/g, '/'));
  if (normalized === '.' || normalized.startsWith('/') ||
      normalized.split('/').some(segment => segment === '..')) {
    return null;
  }
  return normalized;
}

function getImageMimeType(imagePath, image) {
  const extension = path.posix.extname(imagePath).toLowerCase();
  if (extension === '.png' && image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png';
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    if (image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff) return 'image/jpeg';
  }
  if (extension === '.gif' &&
      (image.subarray(0, 6).toString('ascii') === 'GIF87a' ||
       image.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return 'image/gif';
  }
  if (extension === '.webp' && image.toString('ascii', 0, 4) === 'RIFF' &&
      image.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

async function readModIconDataUrl(jarPath) {
  let archive;
  try {
    archive = await openArchive(jarPath);
    const entries = await listEntries(archive);
    for (const metadataName of MOD_METADATA_FILES) {
      const metadataEntry = entries.get(metadataName);
      if (!metadataEntry) continue;

      const metadataBytes = await readEntry(archive, metadataEntry, MAX_METADATA_SIZE);
      let metadata;
      const normalizedMetadataName = metadataName.toLowerCase();
      if (normalizedMetadataName.endsWith('.json') || normalizedMetadataName === 'mcmod.info') {
        try {
          metadata = JSON.parse(metadataBytes.toString('utf8'));
        } catch (error) {
          throw new Error(`Invalid ${metadataName} in mod archive: ${error.message}`);
        }
      } else {
        metadata = metadataBytes.toString('utf8');
      }

      const iconPath = normalizeIconPath(getIconPath(normalizedMetadataName, metadata));
      if (!iconPath) continue;
      const iconEntry = entries.get(iconPath.toLowerCase());
      if (!iconEntry) continue;

      const image = await readEntry(archive, iconEntry, MAX_ICON_SIZE);
      const mimeType = getImageMimeType(iconPath, image);
      if (!mimeType) continue;
      return `data:${mimeType};base64,${image.toString('base64')}`;
    }
    return null;
  } finally {
    if (archive && archive.isOpen) archive.close();
  }
}

module.exports = { readModIconDataUrl };
