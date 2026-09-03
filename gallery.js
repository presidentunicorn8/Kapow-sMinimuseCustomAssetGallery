const SUPABASE_URL = 'https://jiosqsebvezruvhnyplv.supabase.co';
const SUPABASE_KEY = 'sb_publishable_N-vBuDo54MrJfLygIacYVA_TibdMxis';
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const folderInput = document.getElementById('folderInput');
const folderStatus = document.getElementById('folderStatus');
const characterGrid = document.getElementById('characterGrid');

let isSynced = false;
let localCustomAssets = [];
let localWardrobe = [];
let localFilesMap = new Map();

// 1. Read local folder and parse the files that will be merged into downloads
folderInput.addEventListener('change', async (event) => {
  const files = Array.from(event.target.files);
  if (files.length === 0) return;

  localFilesMap = new Map();
  for (const file of files) {
    const relativePath = file.webkitRelativePath.split('/').slice(1).join('/');
    localFilesMap.set(relativePath, file);
  }

  const wardrobeFile = localFilesMap.get('wardrobe.json');
  const customAssetsFile = localFilesMap.get('custom_assets.json');
  if (!wardrobeFile || !customAssetsFile) {
    isSynced = false;
    folderStatus.classList.remove('synced');
    folderStatus.textContent = 'ERROR: Select a MiniMuse folder containing wardrobe.json and custom_assets.json.';
    return;
  }

  try {
    const wardrobeData = JSON.parse(await wardrobeFile.text() || '[]');
    const customAssetsData = JSON.parse(await customAssetsFile.text() || '[]');
    if (!Array.isArray(wardrobeData)) {
      throw new Error('wardrobe.json must contain an array.');
    }
    if (!customAssetsData || typeof customAssetsData !== 'object') {
      throw new Error('custom_assets.json must contain a JSON array or object.');
    }
    localWardrobe = wardrobeData;
    localCustomAssets = customAssetsData;
  } catch (e) {
    isSynced = false;
    folderStatus.classList.remove('synced');
    folderStatus.textContent = `ERROR: Could not parse MiniMuse data: ${e.message}`;
    return;
  }

  isSynced = true;
  folderStatus.classList.add('synced');
  folderStatus.textContent = `Synced MiniMuse folder. ${localWardrobe.length} wardrobe item(s) and ${getRecordCount(localCustomAssets)} custom asset record(s) loaded.`;
});

// 2. Load Gallery Cards
async function loadGallery() {
  const { data: characters, error } = await supabaseClient
    .from('characters')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    characterGrid.innerHTML = `<p>Error loading gallery: ${error.message}</p>`;
    return;
  }

  if (!characters || characters.length === 0) {
    characterGrid.innerHTML = '<p>No characters published yet!</p>';
    return;
  }

  characterGrid.innerHTML = '';

  characters.forEach(char => {
    const card = document.createElement('div');
    card.className = 'card list-card';

    const gameThumb = char.preview_image_url || 'https://via.placeholder.com/80?text=No+Render';
    const creatorThumb = char.user_thumbnail_url || gameThumb; // Fallback if no custom thumb provided
    const customAssetCount = Array.isArray(char.asset_ids) ? char.asset_ids.length : 0;

    card.innerHTML = `
      <div class="thumbnail-pair">
        <div class="thumb-box">
          <span class="thumb-label">Game Render</span>
          <img src="${gameThumb}" class="thumb-img" alt="In-game preview" />
        </div>
        <div class="thumb-box">
          <span class="thumb-label">Creator Artwork</span>
          <img src="${creatorThumb}" class="thumb-img" alt="User thumbnail" />
        </div>
      </div>
      <div class="card-details">
        <span class="thumb-label">Wardrobe item</span>
        <h3 class="card-title">${char.slot_name || 'Unnamed Character'}</h3>
        <p class="asset-count">${customAssetCount} custom asset${customAssetCount === 1 ? '' : 's'} included</p>
      </div>
      <button class="download-btn" id="dl-${char.id || char.slot_file_id}">💾 Download Wardrobe Item</button>
    `;

    characterGrid.appendChild(card);

    document.getElementById(`dl-${char.id || char.slot_file_id}`).addEventListener('click', () => {
      downloadCharacterPackage(char);
    });
  });
}

async function downloadCharacterPackage(char) {
  const btn = document.getElementById(`dl-${char.id || char.slot_file_id}`);
  const originalText = btn.textContent;
  btn.textContent = '⏳ Packaging ZIP...';
  btn.disabled = true;

  try {
    const zip = new JSZip();

    // B. Fetch and append the selected wardrobe entry
    const wardrobeRes = await fetch(char.slot_url);
    if (!wardrobeRes.ok) {
      throw new Error(`Could not fetch wardrobe item: ${wardrobeRes.status}`);
    }
    const wardrobePayload = await wardrobeRes.json();
    const remoteWardrobeEntry = Array.isArray(wardrobePayload) ? wardrobePayload[0] : wardrobePayload;
    if (!remoteWardrobeEntry || typeof remoteWardrobeEntry !== 'object' || !Array.isArray(remoteWardrobeEntry.items)) {
      throw new Error('Downloaded wardrobe data is not a valid wardrobe entry.');
    }

    const mergedWardrobe = isSynced
      ? mergeWardrobeEntries(localWardrobe, remoteWardrobeEntry)
      : [remoteWardrobeEntry];
    zip.file('wardrobe.json', JSON.stringify(mergedWardrobe, null, 2));

    // C. Merge remote custom asset metadata into the local index
    let remoteCustomAssets = [];
    if (char.custom_assets_url) {
      const caRes = await fetch(char.custom_assets_url);
      if (!caRes.ok) {
        throw new Error(`Could not fetch custom asset metadata: ${caRes.status}`);
      }
      const parsedCustomAssets = await caRes.json();
      if (parsedCustomAssets && typeof parsedCustomAssets === 'object') {
        remoteCustomAssets = parsedCustomAssets;
      } else {
        throw new Error('Downloaded custom asset metadata is not a valid JSON array or object.');
      }
    }

    const mergedCustomAssets = isSynced
      ? mergeCustomAssets(localCustomAssets, remoteCustomAssets)
      : remoteCustomAssets;
    zip.file('custom_assets.json', JSON.stringify(mergedCustomAssets, null, 2));

    // D. Fetch raw custom asset files referenced by the wardrobe entry
    const assetIds = findCustomAssetIds(remoteWardrobeEntry);
    const batchFolder = char.slot_url.split('/uploads/')[1].split('/')[0];

    for (const assetId of assetIds) {
      const assetFolder = zip.folder(`custom_assets/${assetId}`);
      const filesToFetch = ['asset_c1.png', 'asset_c2.png', 'asset_c3.png', 'asset_c4.png', 'asset_c5.png', 'asset_c6.png', 'asset_c7.png', 'asset_c8.png', 'asset_line.png', 'thumb.png'];

      for (const fileName of filesToFetch) {
        const fileUrl = `${SUPABASE_URL}/storage/v1/object/public/minimuse-uploads/uploads/${batchFolder}/custom_assets/${assetId}/${fileName}`;
        
        try {
          const fileRes = await fetch(fileUrl);
          if (fileRes.ok) {
            const blob = await fileRes.blob();
            assetFolder.file(fileName, blob);
          }
        } catch (e) {
          // File optional/not present
        }
      }
    }

    // E. Generate & download ZIP
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const downloadLink = document.createElement('a');
    downloadLink.href = URL.createObjectURL(zipBlob);
    downloadLink.download = `${(char.slot_name || 'Wardrobe_Item').replace(/[^a-z0-9]/gi, '_')}_updated.zip`;
    downloadLink.click();
    URL.revokeObjectURL(downloadLink.href);

  } catch (err) {
    alert(`Download failed: ${err.message}`);
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

function mergeWardrobeEntries(existingEntries, newEntry) {
  const entries = Array.isArray(existingEntries) ? [...existingEntries] : [];
  if (!newEntry.id) {
    entries.push(newEntry);
    return entries;
  }

  const existingIndex = entries.findIndex(entry => entry && entry.id === newEntry.id);
  if (existingIndex === -1) {
    entries.push(newEntry);
  }
  return entries;
}

function mergeCustomAssets(existingAssets, newAssets) {
  const remoteRecords = Array.isArray(newAssets) ? newAssets : Object.values(newAssets || {});

  if (Array.isArray(existingAssets)) {
    const mergedAssets = [...existingAssets];
    const existingIds = new Set(
      mergedAssets
        .filter(asset => asset && typeof asset === 'object' && asset.id)
        .map(asset => asset.id)
    );

    remoteRecords.forEach(asset => {
      if (!asset || typeof asset !== 'object' || !asset.id || existingIds.has(asset.id)) return;
      mergedAssets.push(asset);
      existingIds.add(asset.id);
    });
    return mergedAssets;
  }

  const mergedAssets = { ...(existingAssets || {}) };
  const existingIds = new Set(
    Object.values(mergedAssets)
      .filter(asset => asset && typeof asset === 'object' && asset.id)
      .map(asset => asset.id)
  );

  remoteRecords.forEach(asset => {
    if (!asset || typeof asset !== 'object' || !asset.id || existingIds.has(asset.id)) return;

    const targetKey = Object.prototype.hasOwnProperty.call(mergedAssets, asset.id)
      ? `custom_asset_${asset.id}`
      : asset.id;
    mergedAssets[targetKey] = asset;
    existingIds.add(asset.id);
  });

  return mergedAssets;
}

function getRecordCount(records) {
  return Array.isArray(records) ? records.length : Object.keys(records || {}).length;
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
loadGallery();