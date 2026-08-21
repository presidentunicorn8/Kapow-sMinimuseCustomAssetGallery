const SUPABASE_URL = 'https://jiosqsebvezruvhnyplv.supabase.co';
const SUPABASE_KEY = 'sb_publishable_N-vBuDo54MrJfLygIacYVA_TibdMxis';
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const folderInput = document.getElementById('folderInput');
const folderStatus = document.getElementById('folderStatus');
const characterGrid = document.getElementById('characterGrid');

let isSynced = false;
let localCustomAssets = {};
let availableSlotsQueue = []; // Array of unused slot filenames 

// 1. Read local folder, merge assets, and detect unused slots
folderInput.addEventListener('change', async (event) => {
  const files = Array.from(event.target.files);
  if (files.length === 0) return;

  isSynced = true;
  folderStatus.classList.add('synced');

  // A. Parse local custom_assets.json if it exists
  const jsonFile = files.find(f => f.name === 'custom_assets.json');
  if (jsonFile) {
    try {
      const text = await jsonFile.text();
      localCustomAssets = JSON.parse(text || '{}');
      console.log('✅ Parsed local custom_assets.json:', Object.keys(localCustomAssets).length, 'entries found.');
    } catch (e) {
      console.warn('⚠️ Failed to parse local custom_assets.json', e);
    }
  }

  // B. Find unmodified slot files (Filtered to slots >= 4)
  const slotFiles = files.filter(f => {
    const match = f.name.match(/^slot_(\d+)\.json$/i);
    return match && parseInt(match[1], 10) >= 4;
  });

  if (slotFiles.length > 0) {
    const timeBuckets = {};

    slotFiles.forEach(f => {
      // 5-minute bucket window (300,000 ms)
      const bucket = Math.floor(f.lastModified / 300000);
      timeBuckets[bucket] = (timeBuckets[bucket] || 0) + 1;
    });

    // Dominant bucket = initial install batch date
    const dominantBucket = Object.keys(timeBuckets).reduce((a, b) => 
      timeBuckets[a] > timeBuckets[b] ? a : b
    );
    const unusedSlots = slotFiles.filter(f => 
      String(Math.floor(f.lastModified / 300000)) === String(dominantBucket)
    );

    // Sort numerically by slot number (4, 5, 6...)
    availableSlotsQueue = unusedSlots
      .map(f => {
        const match = f.name.match(/\d+/);
        return {
          filename: f.name,
          num: match ? parseInt(match[0], 10) : 0
        };
      })
      .sort((a, b) => a.num - b.num);

    console.log('✅ Target slot identified:', availableSlotsQueue[0]?.filename);
    console.log(`📦 Unused slots found (${availableSlotsQueue.length}):`, availableSlotsQueue.map(s => s.filename));

    const nextSlot = availableSlotsQueue.length > 0 ? availableSlotsQueue[0].filename : 'slot_4.json';
    folderStatus.textContent = `Synced with MiniMuse! Next target slot: ${nextSlot} (${availableSlotsQueue.length} empty slots found).`;
  } else {
    folderStatus.textContent = 'Synced AppData (no slot files >= 4 detected).';
  }
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
        <span class="thumb-label">Character name</span>
        <h3 class="card-title">${char.slot_name || 'Unnamed Character'}</h3>
      </div>
      <button class="download-btn" id="dl-${char.id || char.slot_file_id}">💾 Download Character</button>
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

    let targetSlotFileName = null;

    if (isSynced && availableSlotsQueue.length > 0) {
      const assignedSlot = availableSlotsQueue.shift();
      targetSlotFileName = assignedSlot.filename;

      const nextUp = availableSlotsQueue.length > 0 ? availableSlotsQueue[0].filename : 'None';
      folderStatus.textContent = `Synced. Next empty character slot: ${nextUp} (${availableSlotsQueue.length} empty slots remaining).`;
    }

    // B. Only include the character slot JSON when the user has synced
    if (isSynced) {
      const slotRes = await fetch(char.slot_url);
      const slotText = await slotRes.text();
      zip.file(targetSlotFileName || 'slot_4.json', slotText);
    }

    // C. ONLY generate custom_assets.json if user has SYNCED
    if (isSynced) {
      let remoteCustomAssets = {};
      if (char.custom_assets_url) {
        try {
          const caRes = await fetch(char.custom_assets_url);
          remoteCustomAssets = await caRes.json();
        } catch (e) {
          console.warn('Failed to fetch remote custom_assets.json', e);
        }
      }

      const mergedCustomAssets = { ...localCustomAssets, ...remoteCustomAssets };
      zip.file('custom_assets.json', JSON.stringify(mergedCustomAssets, null, 2));
    }

    // D. Fetch raw custom asset files from Supabase storage
    const assetIds = char.asset_ids || [];
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
    downloadLink.download = `${(char.slot_name || 'Character').replace(/[^a-z0-9]/gi, '_')}_(${targetSlotFileName}).zip`;
    downloadLink.click();
    URL.revokeObjectURL(downloadLink.href);

  } catch (err) {
    alert(`Download failed: ${err.message}`);
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}
loadGallery();