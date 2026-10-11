import { applyRoadEdits } from './road-edits.js';

export class RouteEditor {
    constructor(mapManager, onChange) {
        this.mapManager = mapManager;
        this.onChange = onChange;
        this.layers = L.featureGroup().addTo(mapManager.getMap());
        this.activeDraw = null;
        this.disconnectedPassages = 0;
        this.editControl = new L.Control.Draw({
            position: 'topleft', draw: false, edit: { featureGroup: this.layers, remove: true }
        });
        mapManager.getMap().addControl(this.editControl);
        for (const control of [mapManager.getDrawControl(), this.editControl]) {
            for (const toolbar of Object.values(control._toolbars)) toolbar.on('enable', () => this.finishDrawing());
        }
        const labelTools = () => {
            const control = this.editControl.getContainer();
            for (const [selector, label] of [
                ['.leaflet-draw-edit-edit', 'Edit exclusions and manual passages'],
                ['.leaflet-draw-edit-remove', 'Delete exclusions and manual passages']
            ]) {
                const tool = control.querySelector(selector);
                tool.title = label;
                tool.setAttribute('aria-label', label);
            }
        };
        this.layers.on('layeradd layerremove', labelTools);
        labelTools();
        document.getElementById('drawExclusionButton').addEventListener('click', () => this.startDrawing('exclusion'));
        document.getElementById('drawPassageButton').addEventListener('click', () => this.startDrawing('passage'));
        document.getElementById('passageSnapMeters').addEventListener('change', () => this.onChange());
        mapManager.getMap().on(L.Draw.Event.DRAWSTOP, () => this.finishDrawing());
        this.updateStatus();
    }

    startDrawing(type) {
        this.finishDrawing();
        this.mapManager.disableDepotSelectionMode();
        // Close any other drawing/editing mode before starting this tool.
        for (const control of [this.mapManager.getDrawControl(), this.editControl]) {
            for (const toolbar of Object.values(control._toolbars)) toolbar.disable();
        }
        const options = { routeEditType: type, color: type === 'exclusion' ? '#dc3545' : '#7c3aed', weight: 4 };
        this.activeDraw = type === 'exclusion'
            ? new L.Draw.Polygon(this.mapManager.getMap(), { allowIntersection: false, shapeOptions: { ...options, fillOpacity: 0.2 } })
            : new L.Draw.Polyline(this.mapManager.getMap(), { shapeOptions: options });
        this.activeDraw.enable();
        document.getElementById(type === 'exclusion' ? 'drawExclusionButton' : 'drawPassageButton').classList.add('active');
    }

    finishDrawing() {
        const draw = this.activeDraw;
        this.activeDraw = null;
        if (draw) draw.disable();
        for (const id of ['drawExclusionButton', 'drawPassageButton']) document.getElementById(id).classList.remove('active');
    }

    handleDrawCreated(event) {
        const type = event.layer.options.routeEditType;
        if (!type) return false;
        const layer = event.layer;
        this.layers.addLayer(layer);
        layer.bindTooltip(type === 'exclusion' ? 'Excluded area' : 'Manual passage');
        this.onChange();
        return true;
    }

    handleLayersChanged(event) {
        let changed = false;
        event.layers.eachLayer(layer => { if (layer.options.routeEditType) changed = true; });
        if (changed) this.onChange();
        return changed;
    }

    apply(roads) {
        const exclusions = [], passages = [];
        this.layers.eachLayer(layer => {
            (layer.options.routeEditType === 'exclusion' ? exclusions : passages).push(layer.toGeoJSON());
        });
        const snapMeters = Number(document.getElementById('passageSnapMeters').value);
        const result = applyRoadEdits(roads, exclusions, passages, snapMeters);
        this.disconnectedPassages = result.disconnectedPassages;
        this.updateStatus();
        return result.features;
    }

    updateStatus() {
        let exclusions = 0, passages = 0;
        this.layers.eachLayer(layer => layer.options.routeEditType === 'exclusion' ? exclusions++ : passages++);
        document.getElementById('routeEditsStatus').textContent = `${exclusions} exclusions · ${passages} manual passages` +
            (this.disconnectedPassages ? ` · ${this.disconnectedPassages} disconnected segments: connect their endpoints to a road.` : '');
    }

    reset() {
        this.finishDrawing();
        for (const toolbar of Object.values(this.editControl._toolbars)) toolbar.disable();
        this.layers.clearLayers();
        this.disconnectedPassages = 0;
        this.updateStatus();
    }
}
