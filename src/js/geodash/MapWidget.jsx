import React from "react";

import { Map, View } from "ol";
import { isEmpty as isExtentEmpty } from "ol/extent";
import { Tile as TileLayer, Vector as VectorLayer } from "ol/layer";
import { transformExtent } from "ol/proj";
import { XYZ } from "ol/source";
import { Style, Stroke } from "ol/style";

import { mercator } from "../utils/mercator";

import SvgIcon from "../components/svg/SvgIcon";

const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

export default class MapWidget extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      mapRef: null,
      timeOutRefs: [],
      overlayValue: 100,
      opacityValue: 100,
      loading: false,
      errorMsg: null,
    };
    this.refreshedExpiredCache = new Set();
  }

  /// Lifecycle

  componentDidMount() {
    this.initMap();
  }

  componentWillUnmount() {
    this.state.timeOutRefs.forEach((tor) => window.clearTimeout(tor));
  }

  componentDidUpdate(prevProps, prevState) {
    if (prevProps.isFullScreen !== this.props.isFullScreen && this.state.mapRef) {
      this.state.mapRef.updateSize();
    }

    if (
      this.state.mapRef &&
      (prevProps.mapCenter !== this.props.mapCenter || prevProps.mapZoom !== this.props.mapZoom)
    ) {
      this.centerAndZoomMap(this.props.mapCenter, this.props.mapZoom);
    }

    if (this.props.widget.type === "degradationTool") {
      if (
        prevProps.imageDate !== this.props.imageDate ||
        prevProps.stretch !== this.props.stretch ||
        prevProps.degDataType !== this.props.degDataType
      ) {
        this.pauseGeeLayer();
        if (this.props.imageDate !== "") this.loadWidgetSource();
      }
    } else if (!prevState.mapRef && this.state.mapRef) {
      this.loadWidgetSource();
    }
  }

  /// API

  fetchSourceUrl = async (postObject, cacheKey) => {
    try {
      const res = await fetch("/geo-dash/gateway-request", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(postObject),
      });
      let data = null;
      try {
        data = await res.json();
      } catch (_err) {
        data = null;
      }
      if (!res.ok) {
        const msg =
          (data && (data.errMsg || data.errType)) ||
          `Error del servidor al consultar GEE (HTTP ${res.status}).`;
        console.warn("Geo-Dash gateway HTTP error:", res.status, data);
        return { url: null, error: msg };
      }
      if (data && data.url) {
        this.setCache(cacheKey, data.url);
        return { url: data.url, error: null };
      }
      const errMsg =
        (data && (data.errMsg || data.errType)) ||
        "GEE no devolvió una imagen válida para esta configuración.";
      console.warn("Geo-Dash gateway returned error:", data);
      return { url: null, error: errMsg };
    } catch (err) {
      console.error("Geo-Dash gateway request failed:", err);
      return {
        url: null,
        error: "No se pudo conectar con el servicio de Google Earth Engine.",
      };
    }
  };

  /// State

  updateOpacity = (newOpacity) => {
    this.setState({ opacityValue: newOpacity });
    this.setOpacity(newOpacity);
  };

  updateOverlay = (newOverlay) => {
    this.setState({ overlayValue: newOverlay });
    if (this.state.mapRef) {
      this.state.mapRef.render();
    }
  };

  /// Get widget URL

  getPostObject = (widget) => {
    if (!widget) return null;
    switch (widget.type) {
      case "institutionImagery":
        return null;
      case "imageAsset":
        return { path: "image", ...widget };
      case "degradationTool": {
        const { stretch, imageDate, degDataType, plotExtentPolygon } = this.props;
        return {
          path: "degradationTileUrl",
          geometry: plotExtentPolygon,
          stretch,
          degDataType,
          imageDate,
          ...widget,
        };
      }
      case "polygonCompare": {
        const { visiblePlotId } = this.props;
        return { path: "featureCollection", matchID: visiblePlotId, ...widget };
      }
      case "preImageCollection": {
        const { sourceName, sourceType } = widget;
        const sourceNameToPath = {
          Landsat: "filteredLandsat",
          Sentinel2: "filteredSentinel2",
          "Sentinel-2": "filteredSentinel2",
        };
        const path =
          (sourceType === "Composite" && sourceNameToPath[sourceName]) || "imageCollectionByIndex";
        return {
          path,
          geometry: this.props.plotExtentPolygon,
          ...widget,
        };
      }
      case "imageCollectionAsset":
        return { path: "imageCollection", ...widget };
      case "dynamicWorld":
        return { path: "dynamicWorld", ...widget };
      default:
        return null;
    }
  };

  getCacheKey = (postObject) => {
    if (!postObject) return "";
    if (
      postObject.path === "filteredLandsat" ||
      postObject.path === "filteredSentinel2" ||
      postObject.path === "imageCollectionByIndex"
    ) {
      // eslint-disable-next-line no-unused-vars
      const { geometry, ...cacheableObject } = postObject;
      return JSON.stringify(cacheableObject);
    }
    return JSON.stringify(postObject);
  };

  /// Cache

  wrapCache = async (widget, forceRefresh = false) => {
    const postObject = this.getPostObject(widget);
    if (!postObject || !postObject.path) {
      return { url: null, error: null, cacheKey: "" };
    }
    const cacheKey = this.getCacheKey(postObject);
    if (!forceRefresh) {
      const cacheUrl = this.checkForCache(cacheKey);
      if (cacheUrl) {
        return { url: cacheUrl, error: null, cacheKey };
      }
    } else {
      this.clearCache(cacheKey);
    }
    const result = await this.fetchSourceUrl(postObject, cacheKey);
    return { ...result, cacheKey };
  };

  checkForCache = (cacheKey) => {
    if (!cacheKey) return null;
    try {
      const { url, lastGatewayUpdate } = JSON.parse(localStorage.getItem(cacheKey)) || {};
      if (url && new Date() - new Date(lastGatewayUpdate) < CACHE_TTL_MS) {
        return url;
      }
      localStorage.removeItem(cacheKey);
    } catch (_err) {
      // Ignore storage errors
    }
    return null;
  };

  setCache = (cacheKey, url) => {
    if (!cacheKey || !url) return;
    try {
      localStorage.setItem(
        cacheKey,
        JSON.stringify({ url, lastGatewayUpdate: new Date() })
      );
    } catch (_err) {
      // Ignore storage quota errors
    }
  };

  clearCache = (cacheKey) => {
    if (!cacheKey) return;
    try {
      localStorage.removeItem(cacheKey);
    } catch (_err) {
      // Ignore storage errors
    }
  };

  /// OpenLayers

  initMap = () => {
    const { widget, imageryList = [], plotExtentPolygon } = this.props;
    const defaultImagery = {
      id: -1,
      title: "OpenStreetMap",
      attribution: "OpenStreetMap contributors",
      isProxied: false,
      sourceConfig: { type: "OSM" },
    };
    const { sourceConfig, id, attribution, isProxied } =
      imageryList.find((imagery) => imagery.id === widget.basemapId) ||
      imageryList.find((imagery) => imagery.title === "OpenStreetMap") ||
      imageryList.find((imagery) => imagery.title === "Open Street Map") ||
      imageryList[0] ||
      defaultImagery;
    const basemapLayer = new TileLayer({
      source: mercator.createSource(
        widget.basemapType === "PlanetTFO"
          ? { ...sourceConfig, time: widget.basemapTFODate }
          : sourceConfig,
        id,
        attribution,
        isProxied
      ),
    });
    const plotSampleLayer = new VectorLayer({
      source: this.props.vectorSource,
      style: new Style({
        stroke: new Stroke({
          color: "yellow",
          width: 3,
        }),
        fill: null,
      }),
      zIndex: 100,
    });
    const map = new Map({
      layers: [basemapLayer, plotSampleLayer],
      target: "widget-map_" + widget.id,
      view: new View({
        center: [0, 0],
        projection: "EPSG:3857",
        zoom: 4,
      }),
    });

    this.setState({
      mapRef: map,
    });

    map.on("movestart", this.pauseGeeLayer);
    map.on("moveend", (e) => {
      this.props.setCenterAndZoom(e.map.getView().getCenter(), e.map.getView().getZoom());
      this.resumeGeeLayer();
    });

    const vectorSource = plotSampleLayer.getSource();
    const vectorExtent = vectorSource ? vectorSource.getExtent() : null;
    if (vectorExtent && !isExtentEmpty(vectorExtent)) {
      map.getView().fit(vectorExtent, {
        size: map.getSize(),
        padding: [16, 16, 16, 16],
        maxZoom: 17,
      });
    } else if (Array.isArray(plotExtentPolygon) && plotExtentPolygon.length >= 4) {
      const lons = plotExtentPolygon.map((pt) => pt[0]);
      const lats = plotExtentPolygon.map((pt) => pt[1]);
      const fallbackExtent = transformExtent(
        [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
        "EPSG:4326",
        "EPSG:3857"
      );
      if (!isExtentEmpty(fallbackExtent)) {
        map.getView().fit(fallbackExtent, {
          size: map.getSize(),
          padding: [16, 16, 16, 16],
        });
      }
    }

    if (!this.props.mapCenter) {
      const view = map.getView();
      this.props.setCenterAndZoom(view.getCenter(), view.getZoom());
    }
  };

  addOverlay = (layer) => {
    layer.on("prerender", (event) => {
      const { overlayValue } = this.state;
      const ctx = event.context;
      const width = Math.abs(ctx.canvas.width * (overlayValue / 100.0));
      ctx.save();
      ctx.beginPath();
      if (overlayValue >= 0) {
        ctx.rect(width, 0, ctx.canvas.width - width, ctx.canvas.height);
      } else {
        // Secret code just in case.  It may not be as useful as I thought.
        ctx.rect(0, 0, ctx.canvas.width - width, ctx.canvas.height);
      }
      ctx.clip();
    });

    layer.on("postrender", (event) => {
      const ctx = event.context;
      ctx.restore();
    });
  };

  centerAndZoomMap = (center, zoom) => {
    const { mapRef } = this.state;
    if (!mapRef || !center) return;
    const view = mapRef.getView();
    view.setCenter(center);
    view.setZoom(zoom);
  };

  setOpacity = (newOpacity) => {
    if (!this.state.mapRef) return;
    this.state.mapRef.getLayers().forEach((lyr) => {
      const layerId = lyr.get("layerId") || "";
      if (layerId.includes(this.props.widget.id)) {
        lyr.setOpacity(newOpacity / 100.0);
      }
    });
  };

  getLayerById = (layerId) => {
    const { mapRef } = this.state;
    return (
      mapRef &&
      mapRef
        .getLayers()
        .getArray()
        .find((layer) => layer.get("layerId") === layerId)
    );
  };

  pauseGeeLayer = () => {
    const { mapRef, timeOutRefs } = this.state;
    if (mapRef) {
      timeOutRefs.forEach((tor) => window.clearTimeout(tor));
      this.setState({ timeOutRefs: [] });
      mapRef.getLayers().forEach((lyr) => {
        if (lyr.get("layerId")) lyr.setVisible(false);
      });
    }
  };

  resumeGeeLayer = () => {
    const { mapRef } = this.state;
    if (mapRef) {
      const layers = mapRef.getLayers().getArray();
      const timeOutRefs = layers.map((layer) => {
        const to = 75 * (layer.get("idx") || 0);
        return window.setTimeout(() => {
          layer.setVisible(true);
        }, to);
      });
      this.setState({ timeOutRefs });
    }
  };

  addNewLayer = (url, layerId, idx = 0, cacheKey = "") => {
    const source = new XYZ({
      url,
    });
    source.on("tileloaderror", (error) => {
      if (!error.tile.reloaded) {
        window.setTimeout(() => {
          error.tile.reloaded = true; // eslint-disable-line no-param-reassign
          error.tile.load();
        }, 1000);
      } else if (cacheKey && !this.refreshedExpiredCache.has(cacheKey)) {
        this.refreshedExpiredCache.add(cacheKey);
        this.clearCache(cacheKey);
        this.loadWidgetSource(true);
      }
    });
    const layer = new TileLayer({
      source,
      layerId,
      idx,
      visible: false,
    });
    return layer;
  };

  upsertTileSource = (url, widgetId, idx, newLayerCallback = () => {}, cacheKey = "") => {
    const { mapRef } = this.state;
    if (!mapRef || !url) return;
    const layerId = "layer-" + widgetId;
    const existingLayer = this.getLayerById(layerId);
    if (existingLayer) {
      existingLayer.getSource().setUrl(url);
    } else {
      const layer = this.addNewLayer(url, layerId, idx, cacheKey);
      newLayerCallback(layer);
      mapRef.addLayer(layer);
    }
  };

  loadWidgetSource = async (forceRefresh = false) => {
    const { widget, idx } = this.props;
    if (!widget || widget.type === "institutionImagery") {
      return;
    }
    this.setState({ loading: true, errorMsg: null });
    try {
      if (widget.type === "dualImagery") {
        const [res1, res2] = await Promise.all([
          this.wrapCache(widget.image1, forceRefresh),
          this.wrapCache(widget.image2, forceRefresh),
        ]);
        if (res1.url) this.upsertTileSource(res1.url, widget.id + "-top", idx, undefined, res1.cacheKey);
        if (res2.url) this.upsertTileSource(res2.url, widget.id + "-bottom", idx, this.addOverlay, res2.cacheKey);
        const errors = [res1.error, res2.error].filter(Boolean);
        this.setState({ loading: false, errorMsg: errors.length ? errors.join(" | ") : null });
      } else {
        const res = await this.wrapCache(widget, forceRefresh);
        if (res.url) {
          this.upsertTileSource(res.url, widget.id, idx, undefined, res.cacheKey);
        }
        this.setState({ loading: false, errorMsg: res.error || null });
      }
      this.resumeGeeLayer();
    } catch (err) {
      console.error("Error loading widget source:", err);
      this.setState({
        loading: false,
        errorMsg: err?.message || "Error al cargar la imagen satelital.",
      });
    }
  };

  /// Render functions
  renderSlider = (value, updateFn, icon, title) => (
    <>
      <div style={{ alignItems: "center", display: "flex" }} title={title}>
        <SvgIcon color="rgb(49, 186, 176)" icon={icon} size="1.5rem" />
      </div>
      <input
        className="mapRange"
        max="100"
        min="0"
        onChange={(e) => updateFn(parseInt(e.target.value, 10))}
        step="1"
        type="range"
        value={value}
      />
    </>
  );

  renderSliderControls = () => {
    const { overlayValue, opacityValue } = this.state;
    const { widget } = this.props;

    return (
      <div className="d-flex">
        {widget.type === "dualImagery" ? (
          <>
            {this.renderSlider(opacityValue, this.updateOpacity, "opacity", "Opacity")}
            {this.renderSlider(overlayValue, this.updateOverlay, "overlay", "Overlay Layers")}
          </>
        ) : (
          this.renderSlider(opacityValue, this.updateOpacity, "opacity", "Opacity")
        )}
      </div>
    );
  };

  render() {
    const { widget } = this.props;
    const { loading, errorMsg } = this.state;
    return (
      <>
        <div className="geodash-map-wrapper">
          <div id={"widget-map_" + widget.id} style={{ flex: 1 }} />
          {loading && <div className="geodash-map-status">Cargando capa GEE...</div>}
          {errorMsg && (
            <div className="geodash-map-error" role="alert">
              <span>{errorMsg}</span>
              <button
                className="geodash-map-error-retry"
                onClick={() => this.loadWidgetSource(true)}
                type="button"
              >
                Reintentar
              </button>
            </div>
          )}
        </div>
        {this.renderSliderControls()}
      </>
    );
  }
}
