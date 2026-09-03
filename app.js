// Supabase Configuration
const SUPABASE_URL = 'https://jiosqsebvezruvhnyplv.supabase.co';
const SUPABASE_KEY = 'sb_publishable_N-vBuDo54MrJfLygIacYVA_TibdMxis';

// Renamed instance to avoid global window.supabase collision
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const BUCKET_NAME = 'minimuse-uploads';

const folderInput = document.getElementById('folderInput');
const folderStatus = document.getElementById('folderStatus');
const uploadCard = document.getElementById('uploadCard');
const wardrobeSelect = document.getElementById('wardrobeSelect');
const uploadBtn = document.getElementById('uploadBtn');
const logContainer = document.getElementById('logContainer');
const uploadLog = document.getElementById('uploadLog');

let localFilesMap = new Map();
let existingCustomAssets = {};
let wardrobeEntries = [];

function log(msg) {
  logContainer.classList.remove('hidden');
  const line = document.createElement('div');
  line.textContent = `> ${msg}`;
  uploadLog.appendChild(line);
  uploadLog.scrollTop = uploadLog.scrollHeight;
}

// 1. Scan Local AppData Directory Structure
folderInput.addEventListener('change', async (event) => {
  const files = Array.from(event.target.files);
  if (files.length === 0) return;

  localFilesMap.clear();
  wardrobeSelect.innerHTML = '';
  wardrobeEntries = [];

  for (const file of files) {
    const relativePath = file.webkitRelativePath.split('/').slice(1).join('/');
    localFilesMap.set(relativePath, file);

  }

  if (!localFilesMap.has('wardrobe.json')) {
    folderStatus.textContent = 'ERROR: wardrobe.json was not found in the selected MiniMuse folder.';
    return;
  }

  try {
    const wardrobeText = await localFilesMap.get('wardrobe.json').text();
    const parsedWardrobe = JSON.parse(wardrobeText || '[]');
    if (!Array.isArray(parsedWardrobe)) {
      throw new Error('wardrobe.json must contain an array of wardrobe entries.');
    }
    wardrobeEntries = parsedWardrobe.filter(entry =>
      entry && typeof entry === 'object' && Array.isArray(entry.items)
    );
  } catch (e) {
    folderStatus.textContent = `ERROR: Could not parse wardrobe.json: ${e.message}`;
    return;
  }

  // Parse existing custom_assets.json
  if (localFilesMap.has('custom_assets.json')) {
    try {
      const text = await localFilesMap.get('custom_assets.json').text();
      existingCustomAssets = JSON.parse(text || '{}');
    } catch (e) {
      console.warn("Could not parse custom_assets.json", e);
    }
  }

  folderStatus.textContent = `Loaded MiniMuse folder (${files.length} total files indexed).`;
  wardrobeEntries.forEach((entry, index) => {
    const opt = document.createElement('option');
    const customAssetCount = findCustomAssetIds(entry).length;
    opt.value = entry.id || String(index);
    opt.textContent = `${entry.name || 'Unnamed Wardrobe Item'} (${customAssetCount} custom asset folder${customAssetCount === 1 ? '' : 's'})`;
    wardrobeSelect.appendChild(opt);
  });

  if (wardrobeEntries.length === 0) {
    folderStatus.textContent = 'ERROR: No valid wardrobe entries were found in wardrobe.json.';
    return;
  }

  wardrobeSelect.value = wardrobeEntries[0].id || '0';
  uploadCard.classList.remove('hidden');
});

// 2. Upload Process Execution
uploadBtn.addEventListener('click', async () => {
  const selectedWardrobeId = wardrobeSelect.value;
  uploadLog.innerHTML = '';
  log(`Starting upload sequence for wardrobe item: ${selectedWardrobeId}...`);

  // Read Passphrase Input
  const passphraseElem = document.getElementById('passphraseInput');
  const userPassphrase = passphraseElem ? passphraseElem.value.trim() : '';

  if (!userPassphrase) {
    log('ERROR: Passphrase is required to upload!');
    alert('Please enter the community security passphrase before uploading.');
    return;
  }

  const selectedWardrobe = wardrobeEntries.find((entry, index) =>
    (entry.id || String(index)) === selectedWardrobeId
  );

  if (!selectedWardrobe) {
    log(`ERROR: Selected wardrobe item ${selectedWardrobeId} was not found.`);
    return;
  }

  // Generate Unique ID & Batch Name
  const uniqueId = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const wardrobeFileId = `wardrobe_${uniqueId}.json`;
  const uploadBatchId = `batch_${uniqueId}`;
  const characterProfileName = selectedWardrobe.name || 'Unnamed Wardrobe Item';

  log(`Generated wardrobe file ID: ${wardrobeFileId}`);
  log(`Wardrobe item name: ${characterProfileName}`);

  try {
    // A. Upload Custom Creator Thumbnail (Optional User PNG)
    let userThumbnailUrl = null;
    const customThumbInput = document.getElementById('customThumbInput');
    const customThumbFile = customThumbInput && customThumbInput.files ? customThumbInput.files[0] : null;

    if (customThumbFile) {
      log('Uploading user-provided custom creator thumbnail...');
      const thumbPath = `uploads/${uploadBatchId}/user_thumb.png`;
      userThumbnailUrl = await uploadFileToSupabase(thumbPath, customThumbFile, userPassphrase);
      log('Custom creator thumbnail uploaded!');
    }

    // B. Upload the selected wardrobe entry
    log(`Uploading ${wardrobeFileId} to storage bucket...`);
    const wardrobeText = JSON.stringify(selectedWardrobe, null, 2);
    const wardrobeBlob = new Blob([wardrobeText], { type: 'application/json' });
    const wardrobePath = `uploads/${uploadBatchId}/${wardrobeFileId}`;
    const wardrobeUrl = await uploadFileToSupabase(wardrobePath, wardrobeBlob, userPassphrase);

    // C. Collect Referenced Custom Asset IDs
    const referencedAssetIDs = new Set();
    const items = selectedWardrobe.items || [];

    items.forEach(item => {
      if (item.prefix && item.prefix.includes('user://custom_assets/')) {
        const folderMatch = item.prefix.match(/^user:\/\/custom_assets\/([^/]+)\/asset/);
        if (folderMatch) referencedAssetIDs.add(folderMatch[1]);
      }
      if (item.custom_asset_id) {
        referencedAssetIDs.add(item.custom_asset_id);
      }
    });

    log(`Found ${referencedAssetIDs.size} referenced custom asset folder(s) in ${characterProfileName}.`);
    if (referencedAssetIDs.size === 0) {
      log('This wardrobe item contains no user://custom_assets references, so no custom asset folders will be uploaded.');
    }

    // D. Filter & Upload custom_assets.json Metadata
    const filteredCustomAssets = [];
    const customAssetsById = new Map();
    Object.values(existingCustomAssets).forEach(asset => {
      const assetID = typeof asset === 'object' && asset !== null ? asset.id : null;
      if (assetID && referencedAssetIDs.has(assetID)) {
        customAssetsById.set(assetID, asset);
      }
    });

    Array.from(referencedAssetIDs).forEach(assetID => {
      const asset = customAssetsById.get(assetID);
      if (asset) {
        filteredCustomAssets.push(asset);
      }
    });

    log(`Filtered custom_assets.json to ${filteredCustomAssets.length} matching asset record(s).`);

    const filteredJsonBlob = new Blob([JSON.stringify(filteredCustomAssets, null, 2)], { type: 'application/json' });
    const customAssetsPath = `uploads/${uploadBatchId}/custom_assets.json`;
    const customAssetsUrl = await uploadFileToSupabase(customAssetsPath, filteredJsonBlob, userPassphrase);

    // E. Compile & Upload Single Flattened Preview Thumbnail
    log('Compiling character preview image from custom z-layers...');
    const previewBlob = await generateCharacterPreview(selectedWardrobe, localFilesMap);

    let previewImageUrl = null;
    if (previewBlob) {
      const previewPath = `uploads/${uploadBatchId}/preview.png`;
      previewImageUrl = await uploadFileToSupabase(previewPath, previewBlob, userPassphrase);
      log('Preview thumbnail generated and uploaded!');
    }

    // F. Upload Raw Custom Asset Files
    let uploadedAssetFileCount = 0;
    for (const assetID of referencedAssetIDs) {
      const assetPathPrefix = `custom_assets/${assetID}/`;
      const assetFiles = Array.from(localFilesMap.entries()).filter(([relativePath]) =>
        relativePath.replaceAll('\\', '/').startsWith(assetPathPrefix)
      );

      if (assetFiles.length === 0) {
        log(`WARNING: No local files found for custom asset folder ${assetID}.`);
        continue;
      }

      for (const [relativePath, file] of assetFiles) {
        const normalizedPath = relativePath.replaceAll('\\', '/');
        log(`Uploading asset file: ${normalizedPath}...`);
        const remotePath = `uploads/${uploadBatchId}/${normalizedPath}`;
        await uploadFileToSupabase(remotePath, file, userPassphrase);
        uploadedAssetFileCount += 1;
      }
    }
    log(`Uploaded ${uploadedAssetFileCount} custom asset file(s) across ${referencedAssetIDs.size} referenced folder(s).`);

    // G. Insert Database Record via Passphrase RPC Function
    log('Saving record to Supabase database via secure RPC function...');
    const { data, error: dbError } = await supabaseClient.rpc('upload_character_with_passphrase', {
      p_passphrase: userPassphrase,
      p_slot_name: characterProfileName,
      p_slot_file_id: wardrobeFileId,
      p_slot_url: wardrobeUrl,
      p_preview_image_url: previewImageUrl,
      p_user_thumbnail_url: userThumbnailUrl,
      p_custom_assets_url: customAssetsUrl,
      p_asset_ids: Array.from(referencedAssetIDs)
    });

    if (dbError) {
      log(`Database Error: ${dbError.message}`);
      alert(`Upload rejected by database: ${dbError.message}`);
    } else {
      log(`♡ Successfully published "${characterProfileName}" (${wardrobeFileId})! ♡`);
      alert(`♡ Successfully published "${characterProfileName}"! ♡`);
    }

  } catch (err) {
    log(`ERROR: ${err.message}`);
    alert(`Upload sequence failed: ${err.message}`);
  }
});

// Helper: Canvas Layer Compositor (Excludes thumb.png files)
async function generateCharacterPreview(wardrobeEntry, localFilesMap) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  canvas.width = 1024;
  canvas.height = 1024;

  const items = wardrobeEntry.items || [];
  const customItems = items.filter(item => item.prefix && item.prefix.includes('user://custom_assets/'));

  // Sort items by custom_z or z property
  customItems.sort((a, b) => {
    const zA = a.custom_z !== undefined ? a.custom_z : (a.z || 0);
    const zB = b.custom_z !== undefined ? b.custom_z : (b.z || 0);
    return zA - zB;
  });

  const globalDrawQueue = [];

  for (const item of customItems) {
    const assetID = item.prefix.replace('user://custom_assets/', '').replace('/asset', '');
    if (!assetID) continue;

    const folderFiles = [];
    for (const [relativePath, file] of localFilesMap.entries()) {
      const fileNameLower = file.name.toLowerCase();

      // Ignore thumb.png and non-PNG files
      if (
        relativePath.startsWith(`custom_assets/${assetID}/`) && 
        fileNameLower.endsWith('.png') && 
        !fileNameLower.includes('thumb')
      ) {
        folderFiles.push(file);
      }
    }

    // Sort folder files: c1..c8 in order, asset_line.png on top
    folderFiles.sort((a, b) => {
      const getLayerWeight = (fileName) => {
        const name = fileName.toLowerCase();
        if (name.includes('line')) return 999;

        const cMatch = name.match(/c(\d+)/);
        if (cMatch) {
          return parseInt(cMatch[1], 10);
        }
        return 0;
      };

      return getLayerWeight(a.name) - getLayerWeight(b.name);
    });

    globalDrawQueue.push(...folderFiles);
  }

  if (globalDrawQueue.length === 0) return null;

  // Draw stacked layers onto canvas
  for (const file of globalDrawQueue) {
    try {
      const img = await loadImageFromFile(file);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    } catch (err) {
      console.warn(`Failed to draw layer ${file.name}:`, err);
    }
  }

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
}

function findCustomAssetIds(wardrobeEntry) {
  const assetIds = new Set();
  (wardrobeEntry.items || []).forEach(item => {
    if (item.custom_asset_id) assetIds.add(item.custom_asset_id);
    const match = item.prefix && item.prefix.match(/^user:\/\/custom_assets\/([^/]+)\/asset/);
    if (match) assetIds.add(match[1]);
  });
  return Array.from(assetIds);
}

// Helper: Storage Upload & Public URL Fetch
async function uploadFileToSupabase(filePath, fileBlob, passphrase) {
  const { data, error } = await supabaseClient
    .storage
    .from(BUCKET_NAME)
    .upload(filePath, fileBlob, {
      cacheControl: '3600',
      upsert: true,
      metadata: {
        passphrase: passphrase // Evaluated by PostgreSQL Storage Policy
      }
    });

  if (error) {
    throw new Error(`Storage upload failed for ${filePath}: ${error.message}`);
  }

  // Retrieve public URL after successful upload
  const { data: urlData } = supabaseClient
    .storage
    .from(BUCKET_NAME)
    .getPublicUrl(filePath);

  return urlData.publicUrl;
}