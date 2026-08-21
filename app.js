// Supabase Configuration
const SUPABASE_URL = 'https://jiosqsebvezruvhnyplv.supabase.co';
const SUPABASE_KEY = 'sb_publishable_N-vBuDo54MrJfLygIacYVA_TibdMxis';

// Renamed instance to avoid global window.supabase collision
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const BUCKET_NAME = 'minimuse-uploads';

const folderInput = document.getElementById('folderInput');
const folderStatus = document.getElementById('folderStatus');
const uploadCard = document.getElementById('uploadCard');
const slotSelect = document.getElementById('slotSelect');
const uploadBtn = document.getElementById('uploadBtn');
const logContainer = document.getElementById('logContainer');
const uploadLog = document.getElementById('uploadLog');

let localFilesMap = new Map();
let existingCustomAssets = {};

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
  slotSelect.innerHTML = '';
  const foundSlots = [];

  for (const file of files) {
    const relativePath = file.webkitRelativePath.split('/').slice(1).join('/');
    localFilesMap.set(relativePath, file);

    // Match slot files
    if (file.name.startsWith('slot_') && file.name.endsWith('.json')) {
      const slotNumMatch = file.name.match(/^slot_(\d+)\.json$/i);
      if (slotNumMatch) {
        foundSlots.push(file.name);
      }
    }
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

  // Sort slots numerically (e.g., slot_1.json, slot_2.json, slot_10.json)
  foundSlots.sort((a, b) => {
    const numA = parseInt(a.match(/\d+/)[0], 10);
    const numB = parseInt(b.match(/\d+/)[0], 10);
    return numA - numB;
  });

  // Default to slot_1.json if no slot files exist on disk
  const availableSlots = foundSlots.length > 0 ? foundSlots : ['slot_1.json'];

  // Populate Slot Selector Dropdown
  availableSlots.forEach(slotName => {
    const opt = document.createElement('option');
    opt.value = slotName;
    opt.textContent = slotName;
    slotSelect.appendChild(opt);
  });

  slotSelect.value = availableSlots[0];
  uploadCard.classList.remove('hidden');
});

// 2. Upload Process Execution
uploadBtn.addEventListener('click', async () => {
  const selectedSlot = slotSelect.value;
  uploadLog.innerHTML = '';
  log(`Starting upload sequence for local file: ${selectedSlot}...`);

  // Read Passphrase Input
  const passphraseElem = document.getElementById('passphraseInput');
  const userPassphrase = passphraseElem ? passphraseElem.value.trim() : '';

  if (!userPassphrase) {
    log('ERROR: Passphrase is required to upload!');
    alert('Please enter the community security passphrase before uploading.');
    return;
  }

  if (!localFilesMap.has(selectedSlot)) {
    log(`ERROR: Selected file ${selectedSlot} not found on disk.`);
    return;
  }

  // Read local slot JSON content
  const slotFile = localFilesMap.get(selectedSlot);
  const slotText = await slotFile.text();
  let slotData = {};

  try {
    slotData = JSON.parse(slotText);
  } catch (e) {
    log(`ERROR: Failed to parse JSON in ${selectedSlot}.`);
    return;
  }

  // Generate Unique ID & Batch Name
  const uniqueId = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const slotFileId = `slot_${uniqueId}.json`;
  const uploadBatchId = `batch_${uniqueId}`;
  const characterProfileName = slotData.profile_name || 'Unnamed Character';

  log(`Generated Unique File ID: ${slotFileId}`);
  log(`Character Profile Name: ${characterProfileName}`);

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

    // B. Upload Renamed Slot File
    log(`Uploading ${slotFileId} to storage bucket...`);
    const slotBlob = new Blob([slotText], { type: 'application/json' });
    const slotPath = `uploads/${uploadBatchId}/${slotFileId}`;
    const slotUrl = await uploadFileToSupabase(slotPath, slotBlob, userPassphrase);

    // C. Collect Referenced Custom Asset IDs
    const referencedAssetIDs = new Set();
    const items = slotData.items || [];

    items.forEach(item => {
      if (item.prefix && item.prefix.includes('user://custom_assets/')) {
        const folderID = item.prefix.replace('user://custom_assets/', '').replace('/asset', '');
        if (folderID) referencedAssetIDs.add(folderID);
      }
      if (item.custom_asset_id) {
        referencedAssetIDs.add(item.custom_asset_id);
      }
    });

    // D. Filter & Upload custom_assets.json Metadata
    const filteredCustomAssets = {};
    referencedAssetIDs.forEach(assetID => {
      if (existingCustomAssets[assetID]) {
        filteredCustomAssets[assetID] = existingCustomAssets[assetID];
      }
    });

    const filteredJsonBlob = new Blob([JSON.stringify(filteredCustomAssets, null, 2)], { type: 'application/json' });
    const customAssetsPath = `uploads/${uploadBatchId}/custom_assets.json`;
    const customAssetsUrl = await uploadFileToSupabase(customAssetsPath, filteredJsonBlob, userPassphrase);

    // E. Compile & Upload Single Flattened Preview Thumbnail
    log('Compiling character preview image from custom z-layers...');
    const previewBlob = await generateCharacterPreview(slotData, localFilesMap);

    let previewImageUrl = null;
    if (previewBlob) {
      const previewPath = `uploads/${uploadBatchId}/preview.png`;
      previewImageUrl = await uploadFileToSupabase(previewPath, previewBlob, userPassphrase);
      log('Preview thumbnail generated and uploaded!');
    }

    // F. Upload Raw Custom Asset Files
    for (const assetID of referencedAssetIDs) {
      for (const [relativePath, file] of localFilesMap.entries()) {
        if (relativePath.startsWith(`custom_assets/${assetID}/`)) {
          log(`Uploading asset file: ${relativePath}...`);
          const remotePath = `uploads/${uploadBatchId}/${relativePath}`;
          await uploadFileToSupabase(remotePath, file, userPassphrase);
        }
      }
    }

    // G. Insert Database Record via Passphrase RPC Function
    log('Saving record to Supabase database via secure RPC function...');
    const { data, error: dbError } = await supabaseClient.rpc('upload_character_with_passphrase', {
      p_passphrase: userPassphrase,
      p_slot_name: characterProfileName,
      p_slot_file_id: slotFileId,
      p_slot_url: slotUrl,
      p_preview_image_url: previewImageUrl,
      p_user_thumbnail_url: userThumbnailUrl,
      p_custom_assets_url: customAssetsUrl,
      p_asset_ids: Array.from(referencedAssetIDs)
    });

    if (dbError) {
      log(`Database Error: ${dbError.message}`);
      alert(`Upload rejected by database: ${dbError.message}`);
    } else {
      log(`🎉 Successfully published "${characterProfileName}" (${slotFileId})!`);
      alert(`🎉 Successfully published "${characterProfileName}"!`);
    }

  } catch (err) {
    log(`ERROR: ${err.message}`);
    alert(`Upload sequence failed: ${err.message}`);
  }
});

// Helper: Canvas Layer Compositor (Excludes thumb.png files)
async function generateCharacterPreview(slotData, localFilesMap) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  canvas.width = 1024;
  canvas.height = 1024;

  const items = slotData.items || [];
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