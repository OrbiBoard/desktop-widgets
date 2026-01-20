const { ipcRenderer } = require('electron');

// State
let isEditMode = false;
let gridSize = 50;
let widgets = []; // { id, componentId, x, y, w, h, config: {} }
let processedDefaults = [];
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

let panelState = {
    x: 50,
    y: window.innerHeight - 570, // Bottom-left default (approx height 520 + margin)
    view: 'list', // 'list' | 'settings'
    searchTerm: '',
    sortOrder: 'asc' // 'asc' | 'desc'
};

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
        if (savedConfig.processedDefaults) processedDefaults = savedConfig.processedDefaults;
    }

    // Load Components
    const res = await ipcRenderer.invoke('desktop-widgets:get-components');
    if (res && res.ok && res.components) {
        // Filter components for desktop usage
        components = res.components.filter(c => c.group === 'desktop_widget');

        // Initial panel setup (content only)
    const panel = document.getElementById('component-panel');
    if (panel) {
        // Force reset style to ensure it picks up CSS
        panel.style.display = 'none'; // Initially hidden
        renderComponentPanel();
    }

        // Check for default launcher
        const launcherId = 'desktop-launcher-widget';
        if (!processedDefaults.includes(launcherId)) {
            const launcherComp = components.find(c => c.id === launcherId);
            if (launcherComp) {
                const w = launcherComp.recommendedSize ? launcherComp.recommendedSize.width : 380;
                const h = launcherComp.recommendedSize ? launcherComp.recommendedSize.height : 280;

                // Calculate bottom right position
                const safeWidth = Math.floor(window.innerWidth / gridSize) * gridSize;
                const safeHeight = Math.floor(window.innerHeight / gridSize) * gridSize;

                // Margin 2 grids from right/bottom for better look
                const x = safeWidth - w - (gridSize * 1);
                const y = safeHeight - h - (gridSize * 1);

                addWidget(launcherId, x, y, w, h);
                processedDefaults.push(launcherId);
                saveConfig();
            }
        }
    }

    renderWidgets();
    updateGridBackground();

    // Listeners
    ipcRenderer.on('toggle-edit-mode', toggleEditMode);

    // Force Edit Mode OFF initially to ensure shape is calculated correctly for widgets only
    isEditMode = false;
    updateWindowShape();
    
    // Global Context Menu (Empty Area)
    window.addEventListener('contextmenu', (e) => {
        // Only in Edit Mode (in view mode, background is click-through, so this won't fire)
        // But if shape is [], it will fire.
        if (!isEditMode) return;
        
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, null); // null widget = empty area
    });

    // Handle Left Click on Empty Area in Edit Mode to Show Menu
    window.addEventListener('click', (e) => {
        if (!isEditMode) return;
        
        // Check if clicking on empty area (not widget, not panel, not menu)
        if (e.target === widgetsLayer || e.target === gridOverlay || e.target === app) {
             // If we are selecting, don't show menu
             if (isSelecting) return;
             
             // Check if we just finished dragging/selecting (handled in mouseup, but click fires after)
             // Simple click check
             showContextMenu(e.clientX, e.clientY, null);
        }
    });

    // Setup Panel Interactions
    setupPanelInteractions();

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

        // Calculate selection BEFORE hiding the box
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

        selectionBox.style.display = 'none';

        updateAlignmentToolbar();
    });

    function setupPanelInteractions() {
        const panel = document.getElementById('component-panel');
        const header = panel.querySelector('.panel-header');

        if (!header) return;

        // Header Drag Logic
        header.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startY = e.clientY;
            const initX = panelState.x;
            const initY = panelState.y;

            const onMove = (me) => {
                panelState.x = initX + (me.clientX - startX);
                panelState.y = initY + (me.clientY - startY);
                panel.style.left = `${panelState.x}px`;
                panel.style.top = `${panelState.y}px`;
            };

            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                updateWindowShape(); // Update shape after move
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        // Header Buttons
    const closeBtn = panel.querySelector('#panel-close-btn');
    if (closeBtn) closeBtn.onclick = () => {
        toggleEditMode();
        updateWindowShape(); // Immediately update shape on close
    };

    const settingsBtn = panel.querySelector('#panel-settings-btn');
    const backBtn = panel.querySelector('#panel-back-btn');
    const titleEl = panel.querySelector('#panel-title');

    // Initial state check
    if (panelState.view === 'settings') {
        if (settingsBtn) settingsBtn.style.display = 'none';
        if (backBtn) backBtn.style.display = 'flex';
        if (titleEl) titleEl.innerText = '全局设置 (Settings)';
    } else {
        if (settingsBtn) settingsBtn.style.display = 'flex';
        if (backBtn) backBtn.style.display = 'none';
        if (titleEl) titleEl.innerText = '组件库 (Widgets)';
    }

    if (settingsBtn) {
        settingsBtn.onclick = () => {
            panelState.view = 'settings';
            settingsBtn.style.display = 'none';
            if (backBtn) backBtn.style.display = 'flex';
            if (titleEl) titleEl.innerText = '全局设置 (Settings)';
            renderComponentPanelContent(panel);
        };
    }

    if (backBtn) {
        backBtn.onclick = () => {
            panelState.view = 'list';
            if (settingsBtn) settingsBtn.style.display = 'flex';
            backBtn.style.display = 'none';
            if (titleEl) titleEl.innerText = '组件库 (Widgets)';
            renderComponentPanelContent(panel);
        };
    }
}

    function updateGridBackground() {
        gridOverlay.style.backgroundSize = `${gridSize}px ${gridSize}px`;
    }

    function toggleEditMode() {
        isEditMode = !isEditMode;
        document.body.classList.toggle('edit-mode', isEditMode);

        // If entering edit mode, ensure window accepts mouse
        if (isEditMode) {
            // Edit mode: Full window interactive
            updateWindowShape();
            renderComponentPanel(); // Re-render to ensure panel is visible/updated
        } else {
            // View mode: Only widgets interactive
            closeSettings();
            contextMenu.style.display = 'none';
            clearSelection();
            updateWindowShape();
        }
    }

    function updateWindowShape() {
        if (isEditMode) {
            // In Edit Mode, set shape to empty array [] to make the ENTIRE window interactive
            ipcRenderer.send('desktop-widgets:set-shape', []);
            return;
        }

        const rects = [];

        // 1. Widgets
        widgets.forEach(w => {
            rects.push({ x: w.x, y: w.y, width: w.w, height: w.h });
        });
        
        // Safety: If no widgets and not edit mode, send a 1x1 rect off-screen or empty array?
        // Sending empty array in set-shape (win.setShape) usually means "click-through everywhere" for some APIs, 
        // OR "full window" for others depending on implementation.
        // Electron win.setShape(rects): "Setting an empty array will reset the window to be rectangular." (Wait, that means FULL WINDOW opaque?)
        // NO, win.setShape(rects) - "Sets the shape of the window. The shape is defined by an array of rectangles."
        // If rects is empty [], the window has NO shape, meaning it might be invisible to mouse?
        // Actually, documentation says: "The window will be clipped to the union of the rectangles."
        // So empty array [] -> Nothing is clickable (fully transparent to mouse).
        // BUT, if we pass [] to setShape, it effectively makes the window transparent to mouse events.
        
        // HOWEVER, there's a risk: if we send NO rects, does it default to full window?
        // Let's ensure we send at least one rect if empty to be safe, or trust [] means no interaction.
        // User reported "full screen shape" issue. This happens if we accidentally send a rect that covers screen, 
        // OR if we don't call setShape at all (default is full rect).
        
        // 2. Settings Panel
        const settingsPanel = document.getElementById('settings-panel');
        if (settingsPanel && settingsPanel.style.display !== 'none') {
            const rect = settingsPanel.getBoundingClientRect();
            rects.push({
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height
            });
        }
        
        // 3. Component Panel - MUST be interactive in Edit Mode, but updateWindowShape handles view mode mostly.
        
        // 4. Context Menu
        const contextMenu = document.getElementById('context-menu');
        if (contextMenu && contextMenu.style.display !== 'none') {
            const rect = contextMenu.getBoundingClientRect();
            rects.push({
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height
            });
        }

        ipcRenderer.send('desktop-widgets:set-shape', rects);
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
        alignmentToolbar.style.left = `${minX + (maxX - minX) / 2 - alignmentToolbar.offsetWidth / 2}px`;
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
                selected.forEach(w => w.x = Math.round((centerX - w.w / 2) / gridSize) * gridSize);
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
                selected.forEach(w => w.y = Math.round((centerY - w.h / 2) / gridSize) * gridSize);
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
            widgets,
            processedDefaults
        });
    }

    // Rendering
    function renderComponentPanel() {
        const panel = document.getElementById('component-panel');
        if (!panel) return;

        // Set position (Floating)
        panel.style.left = `${panelState.x}px`;
        panel.style.top = `${panelState.y}px`;

        // Reset content to rebuild? No, we now have structure in HTML.
        // We only render the content part.

        renderComponentPanelContent(panel);
    }

    function renderComponentPanelContent(panel) {
        const content = panel.querySelector('.panel-content');
        if (!content) return;
        content.innerHTML = '';

        if (panelState.view === 'list') {
            renderComponentList(content);
        } else {
            renderSettingsView(content);
        }
    }

    function renderSettingsView(container) {
        container.innerHTML = `
        <div class="settings-view-container" style="padding:15px; color: white;">
            <div style="font-weight:bold; margin-bottom:15px; border-bottom:1px solid #444; padding-bottom:5px;">全局设置 (Global Settings)</div>
            
            <div class="setting-item" style="margin-bottom:20px;">
                <label style="display:block; font-size:12px; margin-bottom:5px;">网格大小 (Grid Size)</label>
                <div style="display:flex; align-items:center;">
                    <input type="range" min="20" max="100" value="${gridSize}" style="flex:1; margin-right:10px;">
                    <span style="font-size:12px; min-width:30px;">${gridSize}px</span>
                </div>
            </div>
            
            <div style="font-size:11px; color:#888;">
                更多设置请在组件右键菜单中配置。<br>
                (Configure widget specific settings via right-click menu.)
            </div>
        </div>
    `;

        const slider = container.querySelector('input[type="range"]');
        slider.addEventListener('input', (e) => {
            gridSize = parseInt(e.target.value);
            container.querySelector('span').innerText = `${gridSize}px`;
            updateGridBackground();
            saveConfig();
        });
    }

    function renderComponentList(container) {
        // Toolbar
        const toolbar = document.createElement('div');
        toolbar.className = 'panel-toolbar';
        toolbar.innerHTML = `
        <div class="search-box">
            <i class="ri-search-line"></i>
            <input type="text" placeholder="搜索..." value="${panelState.searchTerm}">
        </div>
        <button class="sort-btn" title="排序">${panelState.sortOrder === 'asc' ? '<i class="ri-sort-asc"></i>' : '<i class="ri-sort-desc"></i>'}</button>
    `;
        container.appendChild(toolbar);

        // Listeners
        const input = toolbar.querySelector('input');
        input.addEventListener('input', (e) => {
            panelState.searchTerm = e.target.value;
            renderComponentListItems(listDiv);
        });

        toolbar.querySelector('.sort-btn').onclick = () => {
            panelState.sortOrder = panelState.sortOrder === 'asc' ? 'desc' : 'asc';
            renderComponentPanelContent(document.getElementById('component-panel'));
        };

        // List Items Container
        const listDiv = document.createElement('div');
        listDiv.className = 'component-list-items';
        container.appendChild(listDiv);

        renderComponentListItems(listDiv);
    }

    function renderComponentListItems(container) {
        container.innerHTML = '';

        // Filter and Sort
        let filtered = components.filter(c => c.name.toLowerCase().includes(panelState.searchTerm.toLowerCase()));

        filtered.sort((a, b) => {
            if (panelState.sortOrder === 'asc') return a.name.localeCompare(b.name);
            else return b.name.localeCompare(a.name);
        });

        if (filtered.length === 0) {
            container.innerHTML = `<div style="text-align:center;color:#666;padding:20px;font-size:12px;">未找到组件 (No Results)</div>`;
            return;
        }

        filtered.forEach(comp => {
            const item = document.createElement('div');
            item.className = 'component-item';
            item.draggable = true;

            // Preview Container
            const previewContainer = document.createElement('div');
            previewContainer.className = 'component-preview';

            // Iframe Preview
            if (comp.url) {
                const iframe = document.createElement('iframe');
                iframe.src = comp.url;
                iframe.setAttribute('sandbox', 'allow-scripts');
                // No inline styles needed, handled by CSS .component-preview iframe
                previewContainer.appendChild(iframe);
            } else {
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

                const margin = gridSize;
                const safeWidth = Math.floor(window.innerWidth / gridSize) * gridSize;
                const safeHeight = Math.floor(window.innerHeight / gridSize) * gridSize;

                const maxX = safeWidth - margin;
                const maxY = safeHeight - 200;

                const startX = Math.floor((maxX - width) / gridSize) * gridSize;

                let bestX = startX;
                let bestY = margin;
                let found = false;

                for (let x = startX; x >= margin; x -= gridSize) {
                    for (let y = margin; y <= maxY - height; y += gridSize) {
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

                if (!found) {
                    bestX = margin;
                    bestY = margin;
                }

                addWidget(comp.id, bestX, bestY, width, height);
            });

            container.appendChild(item);
        });
    }

    function renderWidgets() {
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
        let comp = getComponentById(widget.componentId);

        // Handle missing component gracefully
        if (!comp) {
            console.warn(`Component not found for widget ${widget.id} (componentId: ${widget.componentId}). Rendering placeholder.`);
            comp = {
                id: widget.componentId,
                name: 'Unknown Component',
                url: '', // No URL
                isMissing: true
            };
        }

        const el = document.createElement('div');
        el.className = 'widget-container';
        if (comp.isMissing) el.classList.add('widget-error');

        el.id = `widget-${widget.id}`;
        el.style.left = `${widget.x}px`;
        el.style.top = `${widget.y}px`;
        el.style.width = `${widget.w}px`;
        el.style.height = `${widget.h}px`;

        // Content
        if (comp.isMissing) {
            const errorDiv = document.createElement('div');
            errorDiv.className = 'widget-content error-placeholder';
            errorDiv.style.background = 'rgba(255, 0, 0, 0.1)';
            errorDiv.style.border = '2px dashed red';
            errorDiv.style.color = 'red';
            errorDiv.style.display = 'flex';
            errorDiv.style.alignItems = 'center';
            errorDiv.style.justifyContent = 'center';
            errorDiv.style.flexDirection = 'column';
            errorDiv.innerHTML = `
        <div style="font-size: 24px;"><i class="ri-error-warning-line"></i></div>
        <div style="font-size: 12px; margin-top: 5px;">Missing: ${widget.componentId}</div>
      `;
            el.appendChild(errorDiv);
        } else {
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
        }

        // Drag Overlay (for easier dragging in edit mode)
        const dragOverlay = document.createElement('div');
        dragOverlay.className = 'widget-drag-overlay';
        el.appendChild(dragOverlay);

        // Resize Handle
        const handle = document.createElement('div');
        handle.className = 'resize-handle';
        el.appendChild(handle);

        // Interaction Logic
        setupInteractions(el, widget, handle);

        widgetsLayer.appendChild(el);
    }

    // Touch Handling for Dragging
    const onTouchStart = (e) => {
        if (!isEditMode) return;
        if (e.target === handle) return; // Resize handled by touch logic for handle
        // Don't prevent default here to allow scrolling if needed, but for dragging we might need to.
        // e.preventDefault(); // Only prevent if we confirm drag
        
        const touch = e.touches[0];
        const startX = touch.clientX;
        const startY = touch.clientY;

        // Selection logic (same as mouse)
        // Note: Touch doesn't usually have ctrl/shift keys unless external keyboard
        if (!selectedWidgetIds.has(widget.id)) {
            selectWidget(widget.id, false);
        }

        const selectedWidgets = widgets.filter(w => selectedWidgetIds.has(w.id));
        const initialPositions = new Map();
        selectedWidgets.forEach(w => initialPositions.set(w.id, { x: w.x, y: w.y }));

        // Initial ghost setup
        ghostIndicator.style.left = `${widget.x}px`;
        ghostIndicator.style.top = `${widget.y}px`;
        ghostIndicator.style.width = `${widget.w}px`;
        ghostIndicator.style.height = `${widget.h}px`;

        let isDragging = false;
        const dragThreshold = 5;

        const onTouchMove = (moveEvent) => {
            const moveTouch = moveEvent.touches[0];
            let dx = moveTouch.clientX - startX;
            let dy = moveTouch.clientY - startY;

            if (!isDragging) {
                if (Math.sqrt(dx * dx + dy * dy) > dragThreshold) {
                    isDragging = true;
                    ghostIndicator.style.display = 'block';
                } else {
                    return;
                }
            }
            
            // Prevent scrolling when dragging widget
            if (moveEvent.cancelable) moveEvent.preventDefault();

            // ... (Same drag logic as mouse, simplified for brevity) ...
            // Boundary checks
            let minDx = -Infinity, maxDx = Infinity;
            let minDy = -Infinity, maxDy = Infinity;

            selectedWidgets.forEach(w => {
                const init = initialPositions.get(w.id);
                minDx = Math.max(minDx, -init.x);
                maxDx = Math.min(maxDx, window.innerWidth - w.w - init.x);
                minDy = Math.max(minDy, -init.y);
                maxDy = Math.min(maxDy, window.innerHeight - w.h - init.y);
            });

            dx = Math.max(minDx, Math.min(dx, maxDx));
            dy = Math.max(minDy, Math.min(dy, maxDy));

            // Update Visuals
            selectedWidgets.forEach(w => {
                const initPos = initialPositions.get(w.id);
                const wel = document.getElementById(`widget-${w.id}`);
                if (wel) {
                    wel.style.left = `${initPos.x + dx}px`;
                    wel.style.top = `${initPos.y + dy}px`;
                }
            });

            // Update Ghost
            const leaderInit = initialPositions.get(widget.id);
            const leaderNewX = leaderInit.x + dx;
            const leaderNewY = leaderInit.y + dy;
            let snapX = Math.round(leaderNewX / gridSize) * gridSize;
            let snapY = Math.round(leaderNewY / gridSize) * gridSize;
            
            ghostIndicator.style.left = `${snapX}px`;
            ghostIndicator.style.top = `${snapY}px`;
            
            widget.lastValidDx = dx;
            widget.lastValidDy = dy;
        };

        const onTouchEnd = (endEvent) => {
            document.removeEventListener('touchmove', onTouchMove);
            document.removeEventListener('touchend', onTouchEnd);
            ghostIndicator.style.display = 'none';

            if (!isDragging) return;

            // Apply changes (Snap Logic)
            const leaderEl = document.getElementById(`widget-${widget.id}`);
            const currentLeft = parseFloat(leaderEl.style.left);
            const currentTop = parseFloat(leaderEl.style.top);
            const snappedLeft = Math.round(currentLeft / gridSize) * gridSize;
            const snappedTop = Math.round(currentTop / gridSize) * gridSize;
            
            const initLeader = initialPositions.get(widget.id);
            const snapDeltaX = snappedLeft - initLeader.x;
            const snapDeltaY = snappedTop - initLeader.y;

            // Apply to all
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

        document.addEventListener('touchmove', onTouchMove, { passive: false });
        document.addEventListener('touchend', onTouchEnd);
    };

    el.addEventListener('touchstart', onTouchStart, { passive: false });
    
    // Touch Handling for Resizing
    const onResizeTouchStart = (e) => {
        if (!isEditMode) return;
        e.stopPropagation();
        
        const touch = e.touches[0];
        const startX = touch.clientX;
        const startY = touch.clientY;
        const initialWidth = widget.w;
        const initialHeight = widget.h;

        ghostIndicator.style.display = 'block';
        // ... set ghost props ...

        const onResizeTouchMove = (moveEvent) => {
            if (moveEvent.cancelable) moveEvent.preventDefault();
            const moveTouch = moveEvent.touches[0];
            const dx = moveTouch.clientX - startX;
            const dy = moveTouch.clientY - startY;
            const newW = Math.max(gridSize, initialWidth + dx);
            const newH = Math.max(gridSize, initialHeight + dy);

            el.style.width = `${newW}px`;
            el.style.height = `${newH}px`;
            
            // Ghost update logic...
        };

        const onResizeTouchEnd = () => {
            document.removeEventListener('touchmove', onResizeTouchMove);
            document.removeEventListener('touchend', onResizeTouchEnd);
            ghostIndicator.style.display = 'none';
            
            // Finalize resize logic (snap to grid)
            const currentW = parseFloat(el.style.width);
            const currentH = parseFloat(el.style.height);
            widget.w = Math.round(currentW / gridSize) * gridSize;
            widget.h = Math.round(currentH / gridSize) * gridSize;
            if (widget.w < gridSize) widget.w = gridSize;
            if (widget.h < gridSize) widget.h = gridSize;
            
            el.style.width = `${widget.w}px`;
            el.style.height = `${widget.h}px`;
            saveConfig();
        };

        document.addEventListener('touchmove', onResizeTouchMove, { passive: false });
        document.addEventListener('touchend', onResizeTouchEnd);
    };

    handle.addEventListener('touchstart', onResizeTouchStart, { passive: false });
    // With setShape, background is already transparent/non-interactive.
    // We use blur to close popups if user clicks outside (on desktop).
    window.addEventListener('blur', () => {
        if (!isEditMode) {
            // Close context menu on blur
            if (contextMenu.style.display !== 'none') {
                contextMenu.style.display = 'none';
                updateWindowShape();
            }
            // Do NOT close settings on blur immediately, user might be interacting with a system dialog or another window
            // and we want settings to persist until explicitly closed or user clicks background (which is handled by shape).
            // Actually, since shape makes background click-through, clicking desktop WILL cause blur.
            // So closing settings on blur is actually correct behavior for "clicking outside".
            if (settingsOverlay.style.display !== 'none') {
                 closeSettings();
                 updateWindowShape();
            }
        }
    });

    function setupInteractions(el, widget, handle) {
        // Context Menu (Always allowed, but different options)
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation(); // Stop propagation to avoid issues
            
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

            // ghostIndicator.style.display = 'block'; // Moved to onMove start logic to prevent showing on simple click
            // Set initial ghost
            ghostIndicator.style.left = `${widget.x}px`;
            ghostIndicator.style.top = `${widget.y}px`;
            ghostIndicator.style.width = `${widget.w}px`;
            ghostIndicator.style.height = `${widget.h}px`;

            let isDragging = false;
            const dragThreshold = 5; // px

            const onMove = (moveEvent) => {
                let dx = moveEvent.clientX - startX;
                let dy = moveEvent.clientY - startY;

                if (!isDragging) {
                    if (Math.sqrt(dx * dx + dy * dy) > dragThreshold) {
                        isDragging = true;
                        ghostIndicator.style.display = 'block'; // Show only when actually dragging
                    } else {
                        return;
                    }
                }

                // Boundary checks: Constrain dx/dy so NO widget goes off screen
                // Calculate allowed range
                let minDx = -Infinity, maxDx = Infinity;
                let minDy = -Infinity, maxDy = Infinity;

                selectedWidgets.forEach(w => {
                    const init = initialPositions.get(w.id);
                    // Min dx: widget.x + dx >= 0 -> dx >= -widget.x
                    minDx = Math.max(minDx, -init.x);
                    // Max dx: widget.x + w + dx <= window.innerWidth -> dx <= window.innerWidth - w - x
                    maxDx = Math.min(maxDx, window.innerWidth - w.w - init.x);

                    // Min dy: widget.y + dy >= 0 -> dy >= -widget.y
                    minDy = Math.max(minDy, -init.y);
                    // Max dy: widget.y + h + dy <= window.innerHeight -> dy <= window.innerHeight - h - y
                    maxDy = Math.min(maxDy, window.innerHeight - w.h - init.y);
                });

                dx = Math.max(minDx, Math.min(dx, maxDx));
                dy = Math.max(minDy, Math.min(dy, maxDy));

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

                // Clamp Snap Calculation to avoid OOB
                const minSnapX = 0;
                const maxSnapX = Math.floor((window.innerWidth - widget.w) / gridSize) * gridSize;
                const minSnapY = 0;
                const maxSnapY = Math.floor((window.innerHeight - widget.h) / gridSize) * gridSize;

                let snapX = Math.round(leaderNewX / gridSize) * gridSize;
                let snapY = Math.round(leaderNewY / gridSize) * gridSize;

                snapX = Math.max(minSnapX, Math.min(snapX, maxSnapX));
                snapY = Math.max(minSnapY, Math.min(snapY, maxSnapY));

                ghostIndicator.style.left = `${snapX}px`;
                ghostIndicator.style.top = `${snapY}px`;

                // Store current valid dx/dy for onUp
                widget.lastValidDx = dx;
                widget.lastValidDy = dy;

                // Check collision for ghost (Visual Feedback)
                let ghostOverlap = false;
                const unselectedWidgets = widgets.filter(w => !selectedWidgetIds.has(w.id));

                // Calculate snap delta relative to leader original pos
                // snapX/Y are leader's new snapped pos
                const snapDeltaX = snapX - leaderInit.x;
                const snapDeltaY = snapY - leaderInit.y;

                for (const w of selectedWidgets) {
                    const init = initialPositions.get(w.id);
                    const dest = {
                        x: init.x + snapDeltaX,
                        y: init.y + snapDeltaY,
                        w: w.w,
                        h: w.h
                    };

                    // Boundary check for ghost
                    if (dest.x < 0 || dest.y < 0 || dest.x + dest.w > window.innerWidth || dest.y + dest.h > window.innerHeight) {
                        ghostOverlap = true;
                        break;
                    }

                    for (const other of unselectedWidgets) {
                        if (dest.x < other.x + other.w &&
                            dest.x + dest.w > other.x &&
                            dest.y < other.y + other.h &&
                            dest.y + dest.h > other.y) {
                            ghostOverlap = true;
                            break;
                        }
                    }
                    if (ghostOverlap) break;
                }

                if (ghostOverlap) ghostIndicator.classList.add('error');
                else ghostIndicator.classList.remove('error');
            };

            const onUp = (upEvent) => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);

                selectedWidgets.forEach(w => {
                    const wel = document.getElementById(`widget-${w.id}`);
                    if (wel) wel.classList.remove('is-dragging');
                });

                ghostIndicator.style.display = 'none';

                // Check if dropped on component panel (Remove)
        const panel = document.getElementById('component-panel');
        if (panel && panel.style.display !== 'none') {
            const panelRect = panel.getBoundingClientRect();
            // Check if pointer is within panel bounds
            if (upEvent.clientX >= panelRect.left && 
                upEvent.clientX <= panelRect.right &&
                upEvent.clientY >= panelRect.top &&
                upEvent.clientY <= panelRect.bottom) {
                
                selectedWidgets.forEach(w => removeWidget(w.id));
                clearSelection();
                return;
            }
        }

                // If we didn't drag far enough, just return (Click treated as selection only)
                if (!isDragging) {
                    return;
                }

                // Calculate Snap Delta based on Leader using the LAST VALID dx/dy
                // We re-calculate based on visual position which is already clamped
                const leaderEl = document.getElementById(`widget-${widget.id}`);
                const currentLeft = parseFloat(leaderEl.style.left);
                const currentTop = parseFloat(leaderEl.style.top);

                const snappedLeft = Math.round(currentLeft / gridSize) * gridSize;
                const snappedTop = Math.round(currentTop / gridSize) * gridSize;

                const initLeader = initialPositions.get(widget.id);
                const snapDeltaX = snappedLeft - initLeader.x;
                const snapDeltaY = snappedTop - initLeader.y;

                // Check for overlap
                let hasOverlap = false;
                const tempPositions = new Map();

                // First calculate where everyone WOULD go
                selectedWidgets.forEach(w => {
                    const init = initialPositions.get(w.id);
                    const destX = init.x + snapDeltaX;
                    const destY = init.y + snapDeltaY;
                    tempPositions.set(w.id, { x: destX, y: destY, w: w.w, h: w.h });
                });

                // Check collision with unselected widgets
                const unselectedWidgets = widgets.filter(w => !selectedWidgetIds.has(w.id));

                for (const w of selectedWidgets) {
                    const dest = tempPositions.get(w.id);
                    // Boundary check (double check snapped)
                    if (dest.x < 0 || dest.y < 0 || dest.x + dest.w > window.innerWidth || dest.y + dest.h > window.innerHeight) {
                        hasOverlap = true; // Treat OOB as overlap/invalid
                        break;
                    }

                    for (const other of unselectedWidgets) {
                        if (dest.x < other.x + other.w &&
                            dest.x + dest.w > other.x &&
                            dest.y < other.y + other.h &&
                            dest.y + dest.h > other.y) {
                            hasOverlap = true;
                            break;
                        }
                    }
                    if (hasOverlap) break;
                }

                if (hasOverlap) {
                    // Revert visual positions
                    selectedWidgets.forEach(w => {
                        const init = initialPositions.get(w.id);
                        const wel = document.getElementById(`widget-${w.id}`);
                        if (wel) {
                            wel.style.left = `${init.x}px`;
                            wel.style.top = `${init.y}px`;
                        }
                    });
                    // Do not save config
                } else {
                    // Apply changes
                    selectedWidgets.forEach(w => {
                        const dest = tempPositions.get(w.id);
                        w.x = dest.x;
                        w.y = dest.y;

                        const wel = document.getElementById(`widget-${w.id}`);
                        if (wel) {
                            wel.style.left = `${w.x}px`;
                            wel.style.top = `${w.y}px`;
                        }
                    });
                    saveConfig();
                }

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
        
        // Update shape to include menu
        updateWindowShape();

        // Clear existing menu items first to rebuild
        contextMenu.innerHTML = '';
        
        // CASE 1: Clicked on Empty Area (No Widget)
        if (!widget) {
            // Edit Mode Options for Empty Area
            if (isEditMode) {
                 const btnShowPanel = document.createElement('div');
                 btnShowPanel.className = 'menu-item';
                 btnShowPanel.innerText = '组件库 (Widgets Panel)';
                 btnShowPanel.onclick = () => {
                     // Move panel to mouse position or reset? 
                     // Request said: "Move to mouse area"
                     panelState.x = x;
                     panelState.y = y;
                     // Clamp to screen
                     if (panelState.x + 340 > window.innerWidth) panelState.x = window.innerWidth - 350;
                     if (panelState.y + 520 > window.innerHeight) panelState.y = window.innerHeight - 530;
                     
                     renderComponentPanel(); // Apply new pos
                     contextMenu.style.display = 'none';
                     updateWindowShape();
                 };
                 contextMenu.appendChild(btnShowPanel);
                 
                 const btnExitEdit = document.createElement('div');
                 btnExitEdit.className = 'menu-item';
                 btnExitEdit.innerText = '退出编辑 (Exit Edit Mode)';
                 btnExitEdit.onclick = () => {
                     toggleEditMode();
                     contextMenu.style.display = 'none';
                     updateWindowShape();
                 };
                 contextMenu.appendChild(btnExitEdit);
            } else {
                // View Mode Empty Area (Usually unreachable due to shape, but if triggered via IPC or edge case)
                const btnEnterEdit = document.createElement('div');
                btnEnterEdit.className = 'menu-item';
                btnEnterEdit.innerText = '进入编辑模式 (Edit Mode)';
                btnEnterEdit.onclick = () => {
                    toggleEditMode();
                    contextMenu.style.display = 'none';
                    updateWindowShape();
                };
                contextMenu.appendChild(btnEnterEdit);
            }
            
            setupMenuClose();
            return;
        }
        
        // CASE 2: Clicked on Widget (Existing logic)
        
        // Enter Edit Mode (if not active)
        if (!isEditMode) {
            const btnEdit = document.createElement('div');
            btnEdit.className = 'menu-item';
            btnEdit.innerText = '进入编辑模式 (Edit Mode)';
            btnEdit.onclick = () => {
                toggleEditMode();
                contextMenu.style.display = 'none';
                updateWindowShape();
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
            updateWindowShape();
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
                updateWindowShape();
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
                updateWindowShape();
            };
            contextMenu.appendChild(btnRemove);
        }

        // Click outside to close
        setupMenuClose();
    }

    function setupMenuClose() {
        const closeMenu = (ev) => {
            // If clicking inside menu, do nothing
            if (contextMenu.contains(ev.target)) return;
            
            contextMenu.style.display = 'none';
            document.removeEventListener('click', closeMenu);
            updateWindowShape();
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
}

// Start
init();
