const { ipcRenderer } = require('electron');

// State
let isEditMode = false;
let gridSize = 50;
let widgets = []; // { id, componentId, x, y, w, h, config: {} }
let components = []; // List of available components
let activeSettingsWidgetId = null;

// DOM Elements
const app = document.getElementById('app');
const gridOverlay = document.getElementById('grid-overlay');
const widgetsLayer = document.getElementById('widgets-layer');
const componentPanel = document.getElementById('component-panel');
const contextMenu = document.getElementById('context-menu');
const settingsOverlay = document.getElementById('settings-overlay');

let selectedWidgetIds = new Set();
let isSelecting = false;
let selectionStart = { x: 0, y: 0 };
let selectionBox = null;
let alignmentToolbar = null;

// Initialization
async function init() {
  // Create Ghost Indicator
  ghostIndicator = document.createElement('div');
  ghostIndicator.className = 'ghost-indicator';
  widgetsLayer.appendChild(ghostIndicator);
  
  // Create Selection Box
  selectionBox = document.createElement('div');
  selectionBox.id = 'selection-box';
  widgetsLayer.appendChild(selectionBox);

  // Create Alignment Toolbar
  alignmentToolbar = document.createElement('div');
  alignmentToolbar.id = 'alignment-toolbar';
  alignmentToolbar.style.display = 'none';
  alignmentToolbar.innerHTML = `
    <button class="align-btn" title="Align Left" data-action="left"><i class="ri-align-left"></i></button>
    <button class="align-btn" title="Align Center" data-action="center-h"><i class="ri-align-center"></i></button>
    <button class="align-btn" title="Align Right" data-action="right"><i class="ri-align-right"></i></button>
    <div style="width:1px;background:#555;margin:0 2px;"></div>
    <button class="align-btn" title="Align Top" data-action="top"><i class="ri-align-top"></i></button>
    <button class="align-btn" title="Align Middle" data-action="center-v"><i class="ri-align-vertically"></i></button>
    <button class="align-btn" title="Align Bottom" data-action="bottom"><i class="ri-align-bottom"></i></button>
    <div style="width:1px;background:#555;margin:0 2px;"></div>
    <button class="align-btn" title="Match Width" data-action="match-w"><i class="ri-text-spacing"></i></button>
    <button class="align-btn" title="Match Height" data-action="match-h"><i class="ri-aspect-ratio-line"></i></button>
  `;
  widgetsLayer.appendChild(alignmentToolbar);
  
  alignmentToolbar.addEventListener('mousedown', (e) => e.stopPropagation()); // Prevent selection reset
  alignmentToolbar.querySelectorAll('.align-btn').forEach(btn => {
      btn.addEventListener('click', () => {
          alignSelectedWidgets(btn.dataset.action);
      });
  });

  // Load Config
  const savedConfig = await ipcRenderer.invoke('desktop-widgets:load-config');
  if (savedConfig) {
    if (savedConfig.gridSize) gridSize = savedConfig.gridSize;
    if (savedConfig.widgets) widgets = savedConfig.widgets;
  }

  // Load Components
  const res = await ipcRenderer.invoke('desktop-widgets:get-components');
  if (res && res.ok && res.components) {
    // Filter components for desktop usage
    components = res.components.filter(c => c.usage === 'desktop');
    renderComponentPanel();
  }

  renderWidgets();
  updateGridBackground();

  // Listeners
  ipcRenderer.on('toggle-edit-mode', toggleEditMode);

  // Marquee Selection Logic
  widgetsLayer.addEventListener('mousedown', (e) => {
    if (!isEditMode) return;
    if (e.target !== widgetsLayer && e.target !== gridOverlay && e.target !== app) return;
    
    // Clear selection if not holding shift/ctrl
    if (!e.shiftKey && !e.ctrlKey) {
        clearSelection();
    }
    
    isSelecting = true;
    selectionStart = { x: e.clientX, y: e.clientY };
    selectionBox.style.display = 'block';
    selectionBox.style.left = `${e.clientX}px`;
    selectionBox.style.top = `${e.clientY}px`;
    selectionBox.style.width = '0px';
    selectionBox.style.height = '0px';
    
    // Hide alignment toolbar while selecting
    updateAlignmentToolbar();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isSelecting) return;
    
    const currentX = e.clientX;
    const currentY = e.clientY;
    
    const left = Math.min(selectionStart.x, currentX);
    const top = Math.min(selectionStart.y, currentY);
    const width = Math.abs(currentX - selectionStart.x);
    const height = Math.abs(currentY - selectionStart.y);
    
    selectionBox.style.left = `${left}px`;
    selectionBox.style.top = `${top}px`;
    selectionBox.style.width = `${width}px`;
    selectionBox.style.height = `${height}px`;
  });

  window.addEventListener('mouseup', (e) => {
    if (!isSelecting) return;
    isSelecting = false;
    selectionBox.style.display = 'none';
    
    // Calculate selection
    const boxRect = selectionBox.getBoundingClientRect();
    if (boxRect.width > 5 && boxRect.height > 5) {
        widgets.forEach(w => {
            const el = document.getElementById(`widget-${w.id}`);
            if (!el) return;
            const rect = el.getBoundingClientRect();
            
            // Check intersection
            if (rect.left < boxRect.right && rect.right > boxRect.left &&
                rect.top < boxRect.bottom && rect.bottom > boxRect.top) {
                selectWidget(w.id, true);
            }
        });
    }
    
    updateAlignmentToolbar();
  });
}

function updateGridBackground() {
  gridOverlay.style.backgroundSize = `${gridSize}px ${gridSize}px`;
}

function toggleEditMode() {
  isEditMode = !isEditMode;
  document.body.classList.toggle('edit-mode', isEditMode);
  
  // If entering edit mode, ensure window accepts mouse
  if (isEditMode) {
      ipcRenderer.send('desktop-widgets:set-ignore-mouse', false);
  } else {
      // If exiting edit mode, set ignore mouse (click-through empty areas)
      ipcRenderer.send('desktop-widgets:set-ignore-mouse', true);
      
      // Close settings if open
      closeSettings();
      contextMenu.style.display = 'none';
      clearSelection();
  }
}

function clearSelection() {
    selectedWidgetIds.forEach(id => {
        const el = document.getElementById(`widget-${id}`);
        if (el) el.classList.remove('is-selected');
    });
    selectedWidgetIds.clear();
    updateAlignmentToolbar();
}

function selectWidget(id, addToSelection = false) {
    if (!addToSelection) clearSelection();
    selectedWidgetIds.add(id);
    const el = document.getElementById(`widget-${id}`);
    if (el) el.classList.add('is-selected');
    updateAlignmentToolbar();
}

function updateAlignmentToolbar() {
    if (!alignmentToolbar) return;
    
    if (selectedWidgetIds.size < 2 || isSelecting) {
        alignmentToolbar.style.display = 'none';
        return;
    }
    
    // Calculate bounding box of selection
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    selectedWidgetIds.forEach(id => {
        const w = widgets.find(widget => widget.id === id);
        if (w) {
            minX = Math.min(minX, w.x);
            minY = Math.min(minY, w.y);
            maxX = Math.max(maxX, w.x + w.w);
            maxY = Math.max(maxY, w.y + w.h);
        }
    });
    
    // Position toolbar below the selection
    alignmentToolbar.style.display = 'flex';
    alignmentToolbar.style.left = `${minX + (maxX - minX)/2 - alignmentToolbar.offsetWidth/2}px`;
    alignmentToolbar.style.top = `${maxY + 10}px`;
}

function alignSelectedWidgets(action) {
    if (selectedWidgetIds.size < 2) return;
    
    const selected = widgets.filter(w => selectedWidgetIds.has(w.id));
    if (selected.length === 0) return;

    let targetVal = 0;
    
    switch (action) {
        case 'left':
            targetVal = Math.min(...selected.map(w => w.x));
            selected.forEach(w => w.x = targetVal);
            break;
        case 'right':
            const rightEdge = Math.max(...selected.map(w => w.x + w.w));
            selected.forEach(w => w.x = rightEdge - w.w);
            break;
        case 'center-h':
            const minX = Math.min(...selected.map(w => w.x));
            const maxX = Math.max(...selected.map(w => w.x + w.w));
            const centerX = minX + (maxX - minX) / 2;
            selected.forEach(w => w.x = Math.round((centerX - w.w/2) / gridSize) * gridSize);
            break;
        case 'top':
            targetVal = Math.min(...selected.map(w => w.y));
            selected.forEach(w => w.y = targetVal);
            break;
        case 'bottom':
            const bottomEdge = Math.max(...selected.map(w => w.y + w.h));
            selected.forEach(w => w.y = bottomEdge - w.h);
            break;
        case 'center-v':
            const minY = Math.min(...selected.map(w => w.y));
            const maxY = Math.max(...selected.map(w => w.y + w.h));
            const centerY = minY + (maxY - minY) / 2;
            selected.forEach(w => w.y = Math.round((centerY - w.h/2) / gridSize) * gridSize);
            break;
        case 'match-w':
            targetVal = Math.max(...selected.map(w => w.w));
            selected.forEach(w => w.w = targetVal);
            break;
        case 'match-h':
            targetVal = Math.max(...selected.map(w => w.h));
            selected.forEach(w => w.h = targetVal);
            break;
    }

    // Apply changes
    selected.forEach(w => {
        const el = document.getElementById(`widget-${w.id}`);
        if (el) {
            el.style.left = `${w.x}px`;
            el.style.top = `${w.y}px`;
            el.style.width = `${w.w}px`;
            el.style.height = `${w.h}px`;
        }
    });
    
    updateAlignmentToolbar(); // Re-position toolbar
    saveConfig();
}

function saveConfig() {
  ipcRenderer.invoke('desktop-widgets:save-config', {
    gridSize,
    widgets
  });
}

// Rendering
function renderComponentPanel() {
  componentPanel.innerHTML = '';
  
  // Controls Container
  const controlsDiv = document.createElement('div');
  controlsDiv.style.display = 'flex';
  controlsDiv.style.flexDirection = 'column';
  controlsDiv.style.alignItems = 'center';
  controlsDiv.style.marginRight = '20px';
  controlsDiv.style.borderRight = '1px solid rgba(255,255,255,0.1)';
  controlsDiv.style.paddingRight = '20px';
  controlsDiv.style.height = '100%';
  controlsDiv.style.justifyContent = 'center';

  // Grid Size Control
  const gridControl = document.createElement('div');
  gridControl.style.color = 'white';
  gridControl.style.marginBottom = '15px';
  gridControl.style.textAlign = 'center';
  gridControl.innerHTML = `
    <div style="font-size:12px;margin-bottom:5px;">网格大小 (Grid)</div>
    <input type="range" min="20" max="100" value="${gridSize}" id="grid-slider" style="width:100px">
    <div id="grid-val" style="font-size:11px;opacity:0.7">${gridSize}px</div>
  `;
  controlsDiv.appendChild(gridControl);

  // Close Button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'close-edit-btn';
  closeBtn.innerText = '退出编辑 (Exit)';
  closeBtn.style.position = 'static'; // Reset absolute positioning from CSS class for this layout
  closeBtn.onclick = toggleEditMode;
  controlsDiv.appendChild(closeBtn);
  
  componentPanel.appendChild(controlsDiv);

  gridControl.querySelector('#grid-slider').addEventListener('input', (e) => {
    gridSize = parseInt(e.target.value);
    gridControl.querySelector('#grid-val').innerText = `${gridSize}px`;
    updateGridBackground();
    saveConfig(); // Save grid size preference
  });

  // Components List Container
  const listDiv = document.createElement('div');
  listDiv.style.display = 'flex';
  listDiv.style.flexDirection = 'row';
  listDiv.style.overflowX = 'auto';
  listDiv.style.height = '100%';
  listDiv.style.alignItems = 'center';
  
  components.forEach(comp => {
    const item = document.createElement('div');
    item.className = 'component-item';
    item.draggable = true;
    
    // Preview Container
    const previewContainer = document.createElement('div');
    previewContainer.className = 'component-preview';
    previewContainer.style.width = '100%';
    previewContainer.style.height = '80px';
    previewContainer.style.marginBottom = '5px';
    previewContainer.style.position = 'relative';
    previewContainer.style.overflow = 'hidden';
    previewContainer.style.borderRadius = '4px';
    previewContainer.style.background = '#eee'; // Light background for preview

    // Iframe Preview
    if (comp.url) {
        const iframe = document.createElement('iframe');
        iframe.src = comp.url;
        iframe.style.width = '300px'; // Render at a reasonable base width
        iframe.style.height = '200px';
        iframe.style.border = 'none';
        iframe.style.position = 'absolute';
        iframe.style.top = '0';
        iframe.style.left = '0';
        // Scale down to fit 80px height
        const scale = 80 / 200; 
        iframe.style.transform = `scale(${scale})`;
        iframe.style.transformOrigin = '0 0';
        iframe.style.pointerEvents = 'none'; // Disable interaction in preview
        iframe.setAttribute('sandbox', 'allow-scripts'); // Allow scripts but no same-origin (optional, or allow if needed)
        previewContainer.appendChild(iframe);
    } else {
        // Fallback Icon
        previewContainer.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:32px;color:#555;"><i class="ri-puzzle-line"></i></div>`;
    }

    item.appendChild(previewContainer);

    const nameDiv = document.createElement('div');
    nameDiv.className = 'component-name';
    nameDiv.innerText = comp.name;
    item.appendChild(nameDiv);
    
    // Drag to add
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', comp.id);
      e.dataTransfer.effectAllowed = 'copy';
    });

    // Click to add (Auto-Layout)
    item.addEventListener('click', () => {
       const width = comp.recommendedSize ? comp.recommendedSize.width : 300;
       const height = comp.recommendedSize ? comp.recommendedSize.height : 200;
       
       // Find empty slot logic
       // Start from Top-Right (Standard Desktop icon flow usually Left-Top or Right-Top. User requested "Right add first, then Left, then Down")
       // Wait, user said: "新组件优先在右侧添加，超出高度后向左再向下" 
       // -> Prioritize adding to the Right. Exceed height -> Move Left -> Then Down?
       // This phrasing is slightly ambiguous. Usually "Right side" implies filling a column on the right edge.
       // "Exceed height" implies vertical stacking. 
       // "Move Left" implies next column is to the left.
       // So: Fill Rightmost column (Top->Bottom). If full, move to next column to the left.
       
       const margin = gridSize;
       const maxX = window.innerWidth - margin;
       const maxY = window.innerHeight - 200; // Leave space for panel
       
       let bestX = maxX - width; // Start at rightmost column
       let bestY = margin;
       
       let found = false;
       
       // Loop columns from Right to Left
       for (let x = maxX - width; x >= margin; x -= gridSize) {
           // Loop rows from Top to Bottom
           for (let y = margin; y <= maxY - height; y += gridSize) {
               // Check collision with ALL existing widgets
               let collision = false;
               const rect1 = { left: x, right: x + width, top: y, bottom: y + height };
               
               for (const w of widgets) {
                   const rect2 = { left: w.x, right: w.x + w.w, top: w.y, bottom: w.y + w.h };
                   if (rect1.left < rect2.right && rect1.right > rect2.left &&
                       rect1.top < rect2.bottom && rect1.bottom > rect2.top) {
                       collision = true;
                       break;
                   }
               }
               
               if (!collision) {
                   bestX = x;
                   bestY = y;
                   found = true;
                   break;
               }
           }
           if (found) break;
       }
       
       // If no space found, just dump it at top-left or keep default behavior
       if (!found) {
           bestX = margin;
           bestY = margin;
       }
       
       addWidget(comp.id, bestX, bestY, width, height);
    });
    
    listDiv.appendChild(item);
  });
  
  componentPanel.appendChild(listDiv);
}

function renderWidgets() {
  widgetsLayer.innerHTML = '';
  // Re-append permanent elements since we cleared widgetsLayer
  if (ghostIndicator) widgetsLayer.appendChild(ghostIndicator);
  if (selectionBox) widgetsLayer.appendChild(selectionBox);
  if (alignmentToolbar) widgetsLayer.appendChild(alignmentToolbar);
  
  widgets.forEach(widget => {
    createWidgetElement(widget);
  });
}

function getComponentById(id) {
    return components.find(c => c.id === id) || components.find(c => c.name === id);
}

function createWidgetElement(widget) {
  const comp = getComponentById(widget.componentId);
  if (!comp) return;

  const el = document.createElement('div');
  el.className = 'widget-container';
  el.id = `widget-${widget.id}`;
  el.style.left = `${widget.x}px`;
  el.style.top = `${widget.y}px`;
  el.style.width = `${widget.w}px`;
  el.style.height = `${widget.h}px`;

  // Content
  const webview = document.createElement('webview');
  webview.className = 'widget-content';
  webview.setAttribute('nodeintegration', 'true');
  webview.setAttribute('webpreferences', 'contextIsolation=no, nodeIntegration=true'); // Allow widgets to use Node API if needed
  webview.partition = `persist:widget-${widget.id}`; // Independent session/storage per widget
  webview.src = comp.url || comp.entry; // Plugin manager provides url
  
  webview.addEventListener('dom-ready', () => {
    webview.send('config-updated', widget.config || {});
  });

  // Listen for save requests from widget (e.g. Note content)
  webview.addEventListener('ipc-message', (event) => {
    if (event.channel === 'save-settings') {
      widget.config = event.args[0];
      saveConfig();
    }
  });
  
  el.appendChild(webview);

  // Resize Handle
  const handle = document.createElement('div');
  handle.className = 'resize-handle';
  el.appendChild(handle);

  // Interaction Logic
  setupInteractions(el, widget, handle);

  widgetsLayer.appendChild(el);
}

function setupInteractions(el, widget, handle) {
  // Hover effect for mouse forwarding (when NOT in edit mode)
  el.addEventListener('mouseenter', () => {
      if (!isEditMode) {
          ipcRenderer.send('desktop-widgets:set-ignore-mouse', false);
      }
  });

  el.addEventListener('mouseleave', () => {
      if (!isEditMode) {
          ipcRenderer.send('desktop-widgets:set-ignore-mouse', true);
      }
  });

  // Context Menu (Always allowed, but different options)
  el.addEventListener('contextmenu', (e) => {
    // If not edit mode, we need to temporarily enable mouse events to catch this?
    // Actually, if we are here, mouse events are enabled for this element (mouseenter handles it).
    e.preventDefault();
    e.stopPropagation(); // Stop propagation to avoid issues
    
    // In non-edit mode, ensure we force focus/interaction for the menu
    if (!isEditMode) {
         ipcRenderer.send('desktop-widgets:set-ignore-mouse', false);
    }
    
    showContextMenu(e.clientX, e.clientY, widget);
  });

  // Dragging
  el.addEventListener('mousedown', (e) => {
    if (!isEditMode) return;
    if (e.target === handle) return; // Resize handled separately

    e.stopPropagation(); // Stop marquee selection

    const startX = e.clientX;
    const startY = e.clientY;
    
    // Selection logic
    if (e.ctrlKey || e.shiftKey) {
        if (selectedWidgetIds.has(widget.id)) {
            // Deselect? No, usually ctrl adds/removes. Let's say it adds.
            // If already selected, maybe we are preparing to drag group.
        } else {
            selectWidget(widget.id, true);
        }
    } else {
        if (!selectedWidgetIds.has(widget.id)) {
            selectWidget(widget.id, false);
        }
    }
    
    // Prepare dragging for ALL selected widgets
    const selectedWidgets = widgets.filter(w => selectedWidgetIds.has(w.id));
    const initialPositions = new Map(); // id -> {x, y}
    selectedWidgets.forEach(w => initialPositions.set(w.id, { x: w.x, y: w.y }));
    
    el.classList.add('is-dragging'); // Only visual for leader?
    // Maybe add visual class to all selected?
    selectedWidgets.forEach(w => {
         const wel = document.getElementById(`widget-${w.id}`);
         if (wel) wel.classList.add('is-dragging');
    });
    
    ghostIndicator.style.display = 'block';
    // We only show one ghost indicator for the "leader" widget to keep it simple, 
    // OR we could try to show bounding box ghost. 
    // Let's stick to single ghost for the leader (current widget) for grid snapping reference.
    
    // Set initial ghost
    ghostIndicator.style.left = `${widget.x}px`;
    ghostIndicator.style.top = `${widget.y}px`;
    ghostIndicator.style.width = `${widget.w}px`;
    ghostIndicator.style.height = `${widget.h}px`;

    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      
      // Update all selected widgets visual position
      selectedWidgets.forEach(w => {
          const initPos = initialPositions.get(w.id);
          const newLeft = initPos.x + dx;
          const newTop = initPos.y + dy;
          const wel = document.getElementById(`widget-${w.id}`);
          if (wel) {
              wel.style.left = `${newLeft}px`;
              wel.style.top = `${newTop}px`;
          }
      });
      
      // Update Ghost (Leader Snapped)
      const leaderInit = initialPositions.get(widget.id);
      const leaderNewX = leaderInit.x + dx;
      const leaderNewY = leaderInit.y + dy;
      const snapX = Math.round(leaderNewX / gridSize) * gridSize;
      const snapY = Math.round(leaderNewY / gridSize) * gridSize;
      
      ghostIndicator.style.left = `${snapX}px`;
      ghostIndicator.style.top = `${snapY}px`;
    };

    const onUp = (upEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      
      selectedWidgets.forEach(w => {
         const wel = document.getElementById(`widget-${w.id}`);
         if (wel) wel.classList.remove('is-dragging');
      });
      
      ghostIndicator.style.display = 'none';

      // Check if dropped on component panel (Remove) - Only for leader? 
      // Or if ANY widget is dropped there? Let's assume leader.
      const panelRect = componentPanel.getBoundingClientRect();
      if (upEvent.clientY > panelRect.top) {
        selectedWidgets.forEach(w => removeWidget(w.id));
        clearSelection();
        return;
      }

      // Calculate Snap Delta based on Leader
      // Leader current visual pos
      const leaderEl = document.getElementById(`widget-${widget.id}`);
      const currentLeft = parseFloat(leaderEl.style.left);
      const currentTop = parseFloat(leaderEl.style.top);
      
      const snappedLeft = Math.round(currentLeft / gridSize) * gridSize;
      const snappedTop = Math.round(currentTop / gridSize) * gridSize;
      
      const initLeader = initialPositions.get(widget.id);
      const snapDeltaX = snappedLeft - initLeader.x;
      const snapDeltaY = snappedTop - initLeader.y;
      
      // Apply snap delta to ALL widgets
      selectedWidgets.forEach(w => {
          const init = initialPositions.get(w.id);
          w.x = init.x + snapDeltaX;
          w.y = init.y + snapDeltaY;
          
          const wel = document.getElementById(`widget-${w.id}`);
          if (wel) {
              wel.style.left = `${w.x}px`;
              wel.style.top = `${w.y}px`;
          }
      });

      saveConfig();
      updateAlignmentToolbar();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Resizing
  handle.addEventListener('mousedown', (e) => {
    if (!isEditMode) return;
    e.stopPropagation(); // Prevent drag

    const startX = e.clientX;
    const startY = e.clientY;
    const initialWidth = widget.w;
    const initialHeight = widget.h;
    
    ghostIndicator.style.display = 'block';
    ghostIndicator.style.left = `${widget.x}px`;
    ghostIndicator.style.top = `${widget.y}px`;
    ghostIndicator.style.width = `${widget.w}px`;
    ghostIndicator.style.height = `${widget.h}px`;

    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      const newW = Math.max(gridSize, initialWidth + dx);
      const newH = Math.max(gridSize, initialHeight + dy);
      
      el.style.width = `${newW}px`;
      el.style.height = `${newH}px`;
      
      // Update Ghost (Snapped)
      const snapW = Math.round(newW / gridSize) * gridSize;
      const snapH = Math.round(newH / gridSize) * gridSize;
      
      ghostIndicator.style.width = `${Math.max(gridSize, snapW)}px`;
      ghostIndicator.style.height = `${Math.max(gridSize, snapH)}px`;
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      ghostIndicator.style.display = 'none';

      // Snap to grid
      const currentW = parseFloat(el.style.width);
      const currentH = parseFloat(el.style.height);

      widget.w = Math.round(currentW / gridSize) * gridSize;
      widget.h = Math.round(currentH / gridSize) * gridSize;

      // Minimum size 1x1 grid
      if (widget.w < gridSize) widget.w = gridSize;
      if (widget.h < gridSize) widget.h = gridSize;

      el.style.width = `${widget.w}px`;
      el.style.height = `${widget.h}px`;

      saveConfig();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// Logic
function addWidget(componentId, x, y, w, h) {
  const id = `widget_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
  const widget = {
    id,
    componentId,
    x: Math.round(x / gridSize) * gridSize,
    y: Math.round(y / gridSize) * gridSize,
    w: Math.round(w / gridSize) * gridSize,
    h: Math.round(h / gridSize) * gridSize,
    config: {}
  };
  
  widgets.push(widget);
  createWidgetElement(widget);
  saveConfig();
}

function removeWidget(id) {
  widgets = widgets.filter(w => w.id !== id);
  const el = document.getElementById(`widget-${id}`);
  if (el) el.remove();
  saveConfig();
}

// Context Menu
function showContextMenu(x, y, widget) {
  contextMenu.style.left = `${x}px`;
  contextMenu.style.top = `${y}px`;
  contextMenu.style.display = 'block';

  // Clear existing menu items first to rebuild
  contextMenu.innerHTML = '';
  
  // Enter Edit Mode (if not active)
  if (!isEditMode) {
      const btnEdit = document.createElement('div');
      btnEdit.className = 'menu-item';
      btnEdit.innerText = '进入编辑模式 (Edit Mode)';
      btnEdit.onclick = () => {
          toggleEditMode();
          contextMenu.style.display = 'none';
      };
      contextMenu.appendChild(btnEdit);
      
      const sep = document.createElement('div');
      sep.style.borderTop = '1px solid #454545';
      sep.style.margin = '4px 0';
      contextMenu.appendChild(sep);
  }

  // Settings
  const btnSettings = document.createElement('div');
  btnSettings.className = 'menu-item';
  btnSettings.innerText = '设置 (Settings)';
  btnSettings.onclick = () => {
      if (!isEditMode) toggleEditMode(); // Auto enter edit mode for settings
      setTimeout(() => openSettings(widget), 100);
      contextMenu.style.display = 'none';
  };
  contextMenu.appendChild(btnSettings);
  
  if (isEditMode) {
      // Reset Size
      const btnReset = document.createElement('div');
      btnReset.className = 'menu-item';
      btnReset.innerText = '重置大小 (Reset Size)';
      btnReset.onclick = () => {
          const comp = getComponentById(widget.componentId);
          if (comp && comp.recommendedSize) {
              widget.w = Math.round(comp.recommendedSize.width / gridSize) * gridSize;
              widget.h = Math.round(comp.recommendedSize.height / gridSize) * gridSize;
              const el = document.getElementById(`widget-${widget.id}`);
              if (el) {
                  el.style.width = `${widget.w}px`;
                  el.style.height = `${widget.h}px`;
              }
              saveConfig();
          }
          contextMenu.style.display = 'none';
      };
      contextMenu.appendChild(btnReset);

      // Remove
      const btnRemove = document.createElement('div');
      btnRemove.className = 'menu-item';
      btnRemove.innerText = '移除组件 (Remove)';
      btnRemove.style.color = '#ff6b81';
      btnRemove.onclick = () => {
          removeWidget(widget.id);
          contextMenu.style.display = 'none';
      };
      contextMenu.appendChild(btnRemove);
  }

  // Click outside to close
  const closeMenu = (ev) => {
    // If clicking inside menu, do nothing
    if (contextMenu.contains(ev.target)) return;
    
    contextMenu.style.display = 'none';
    document.removeEventListener('click', closeMenu);
    
    // Restore ignore mouse if not in edit mode and settings not open
    if (!isEditMode && !activeSettingsWidgetId) {
        // Check if mouse is currently over a widget
        const elUnderMouse = document.elementFromPoint(ev.clientX, ev.clientY);
        const isWidget = elUnderMouse && elUnderMouse.closest('.widget-container');
        if (!isWidget) {
             ipcRenderer.send('desktop-widgets:set-ignore-mouse', true);
        }
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

// Settings
function openSettings(widget) {
  activeSettingsWidgetId = widget.id;
  
  // Visual effects
  document.body.classList.add('blur-background');
  const el = document.getElementById(`widget-${widget.id}`);
  if (el) el.classList.add('active-settings-widget');

  // Create Settings Panel
  // Position it to the right of the widget, or left if not enough space
  const rect = el.getBoundingClientRect();
  const panelWidth = 350;
  const panelHeight = 500;
  
  let left = rect.right + 20;
  if (left + panelWidth > window.innerWidth) {
    left = rect.left - panelWidth - 20;
  }
  let top = rect.top;
  if (top + panelHeight > window.innerHeight) {
    top = window.innerHeight - panelHeight - 20;
  }
  
  let panel = document.getElementById('settings-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'settings-panel';
    panel.className = 'settings-panel';
    document.body.appendChild(panel);
  }
  
  panel.style.width = `${panelWidth}px`;
  panel.style.height = `${panelHeight}px`;
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.style.display = 'block';
  
  // Store original config for cancel revert
  const originalConfig = JSON.parse(JSON.stringify(widget.config || {}));
  
  // Load Settings Webview
  panel.innerHTML = ''; // Clear previous
  const webview = document.createElement('webview');
  webview.className = 'settings-webview';
  webview.setAttribute('nodeintegration', 'true');
  webview.setAttribute('webpreferences', 'contextIsolation=no, nodeIntegration=true');
  webview.src = `settings.html`; // Generic settings runner
  
  webview.addEventListener('dom-ready', () => {
    // Send schema and data
    const comp = getComponentById(widget.componentId);
    webview.send('init-settings', {
      componentId: widget.componentId,
      config: widget.config || {},
      schema: comp.configSchema // If available, otherwise we need to fetch it.
    });
  });

  webview.addEventListener('ipc-message', (event) => {
    if (event.channel === 'settings-changed') {
        // Real-time preview
        const newConfig = event.args[0];
        const widgetEl = document.getElementById(`widget-${widget.id}`);
        const widgetWebview = widgetEl.querySelector('webview');
        if (widgetWebview) {
            widgetWebview.send('config-updated', newConfig);
        }
    } else if (event.channel === 'save-settings') {
      widget.config = event.args[0];
      saveConfig();
      // Notify widget of update?
      const widgetEl = document.getElementById(`widget-${widget.id}`);
      const widgetWebview = widgetEl.querySelector('webview');
      if (widgetWebview) {
          widgetWebview.send('config-updated', widget.config);
      }
      closeSettings();
    } else if (event.channel === 'cancel-settings') {
      // Revert to original config
      const widgetEl = document.getElementById(`widget-${widget.id}`);
      const widgetWebview = widgetEl.querySelector('webview');
      if (widgetWebview) {
          widgetWebview.send('config-updated', originalConfig);
      }
      closeSettings();
    }
  });

  panel.appendChild(webview);
  settingsOverlay.style.display = 'block';
}

function closeSettings() {
  document.body.classList.remove('blur-background');
  const active = document.querySelector('.active-settings-widget');
  if (active) active.classList.remove('active-settings-widget');
  
  const panel = document.getElementById('settings-panel');
  if (panel) panel.style.display = 'none';
  settingsOverlay.style.display = 'none';
  activeSettingsWidgetId = null;
}

// Drag & Drop from Panel
app.addEventListener('dragover', (e) => {
  if (!isEditMode) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

app.addEventListener('drop', (e) => {
  if (!isEditMode) return;
  e.preventDefault();
  const componentId = e.dataTransfer.getData('text/plain');
  if (componentId) {
    const comp = getComponentById(componentId);
    const width = comp && comp.recommendedSize ? comp.recommendedSize.width : 300;
    const height = comp && comp.recommendedSize ? comp.recommendedSize.height : 200;
    addWidget(componentId, e.clientX, e.clientY, width, height);
  }
});

// Start
init();
