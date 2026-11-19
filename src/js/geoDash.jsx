import "../css/geo-dash.css";

import React from "react";
import ReactDOM from "react-dom";

import { Feature } from "ol";
import { buffer as ExtentBuffer } from "ol/extent";
import { Circle, Point } from "ol/geom";
import { transform as projTransform } from "ol/proj";
import { fromExtent } from "ol/geom/Polygon";
import { Vector } from "ol/source";

import GeoDashNavigationBar from "./geodash/GeoDashNavigationBar";
import WidgetGridItem from "./geodash/WidgetGridItem";

import { mercator } from "./utils/mercator";
import { isArray, isNumber } from "./utils/generalUtils";
import { gridRowHeight } from "./geodash/constants";

import Modal from "./components/Modal";
import {BreadCrumbs} from "./components/PageComponents";

class Geodash extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      widgets: null,
      mapCenter: null,
      mapZoom: null,
      imageryList: [],
      initCenter: null,
      initZoom: null,
      vectorSource: null,
      toggleSamples: props.plotSamples === true || props.plotSamples === "true",
      modal: null,
    };
    this.plotJsonObject = null;
  }

  /// Lifecycle

  componentDidMount() {
    Promise.all([
      this.getInstitutionImagery(),
      this.getWidgetsByProjectId(),
      this.getVectorSource(),
    ])
      .then(([imageryList, widgets, vectorSource]) =>
        this.setState({ imageryList, widgets, vectorSource })
      )
      .catch((response) => {
        console.error("Error initializing Geo-Dash:", response);
        const detail =
          response && response.status
            ? ` (HTTP ${response.status})`
            : response && response.message
            ? `: ${response.message}`
            : "";
        this.setState({
          widgets: [],
          modal: {
            alert: {
              alertType: "GeoDash Alert",
              alertMessage: `Error initializing Geo-Dash${detail}. See console for details.`,
            },
          },
        });
      });
  }

  /// API

  getDefaultImageryFallback = () => [
    {
      id: -1,
      title: "OpenStreetMap",
      attribution: "OpenStreetMap contributors",
      isProxied: false,
      sourceConfig: { type: "OSM" },
    },
  ];

  getInstitutionImagery = async () => {
    const instId = parseInt(this.props.institutionId, 10);
    if (Number.isInteger(instId) && instId > 0) {
      try {
        const response = await fetch(`/get-institution-imagery?institutionId=${instId}`);
        if (response.ok) {
          const data = await response.json();
          if (Array.isArray(data) && data.length > 0) return data;
        }
      } catch (err) {
        console.warn("Could not load institution imagery, falling back to public imagery:", err);
      }
    }
    try {
      const publicRes = await fetch("/get-public-imagery");
      if (publicRes.ok) {
        const publicData = await publicRes.json();
        if (Array.isArray(publicData) && publicData.length > 0) return publicData;
      }
    } catch (err) {
      console.warn("Could not load public imagery, falling back to OpenStreetMap:", err);
    }
    return this.getDefaultImageryFallback();
  };

  getWidgetsByProjectId = () =>
    fetch(`/geo-dash/get-project-widgets?projectId=${this.props.projectId}`).then((response) =>
      response.ok ? response.json() : Promise.reject(response)
    );

  parseGeoJsonSafe = (raw) => {
    if (!raw) return null;
    if (typeof raw === "object") return raw;
    try {
      return JSON.parse(raw);
    } catch (_err) {
      try {
        return JSON.parse(decodeURIComponent(raw));
      } catch (_err2) {
        return null;
      }
    }
  };

  buildSampleFeature = (geom) => {
    const parsed = this.parseGeoJsonSafe(geom);
    if (!parsed) return null;
    try {
      if (
        parsed.type === "Point" &&
        Array.isArray(parsed.coordinates) &&
        parsed.coordinates.length >= 2 &&
        Number.isFinite(Number(parsed.coordinates[0])) &&
        Number.isFinite(Number(parsed.coordinates[1]))
      ) {
        return new Feature(
          new Circle(projTransform(parsed.coordinates, "EPSG:4326", "EPSG:3857"), Number(1.5))
        );
      }
      return new Feature({ geometry: mercator.parseGeoJson(JSON.stringify(parsed), true) });
    } catch (err) {
      console.warn("Skipping invalid sample geometry in Geo-Dash:", err);
      return null;
    }
  };

  buildFeatures = (plotJsonObject, showSamples) => {
    const { plotShape, radius, center } = this.props;
    const safePlot = plotJsonObject && typeof plotJsonObject === "object" ? plotJsonObject : {};
    const parsedCenter = this.parseGeoJsonSafe(center);
    const hasValidCenter =
      parsedCenter &&
      Array.isArray(parsedCenter.coordinates) &&
      parsedCenter.coordinates.length >= 2 &&
      Number.isFinite(Number(parsedCenter.coordinates[0])) &&
      Number.isFinite(Number(parsedCenter.coordinates[1]));
    const numRadius = Number(radius);
    const hasValidRadius = Number.isFinite(numRadius) && numRadius > 0;

    const plotFeatures = [];

    if (plotShape === "square" && hasValidCenter && hasValidRadius) {
      const point = new Point(
        projTransform(parsedCenter.coordinates, "EPSG:4326", "EPSG:3857")
      );
      const [centerX, centerY] = point.getFlatCoordinates();
      plotFeatures.push(
        new Feature(
          fromExtent([
            centerX - numRadius,
            centerY - numRadius,
            centerX + numRadius,
            centerY + numRadius,
          ])
        )
      );
    } else if (plotShape === "circle" && hasValidCenter && hasValidRadius) {
      plotFeatures.push(
        new Feature(
          new Circle(
            projTransform(parsedCenter.coordinates, "EPSG:4326", "EPSG:3857"),
            numRadius
          )
        )
      );
    } else if (safePlot.plotGeom) {
      try {
        plotFeatures.push(
          new Feature({ geometry: mercator.parseGeoJson(safePlot.plotGeom, true) })
        );
      } catch (err) {
        console.warn("Could not parse plotGeom in Geo-Dash:", err);
      }
    }

    const sampleFeatures = showSamples
      ? (safePlot.sampleGeoms || [])
          .filter((e) => e)
          .map((geom) => this.buildSampleFeature(geom))
          .filter((f) => f)
      : [];

    return [...plotFeatures, ...sampleFeatures];
  };

  getFeatures = async () => {
    const { plotId } = this.props;
    let plotJsonObject = {};
    const parsedPlotId = parseInt(plotId, 10);
    if (Number.isInteger(parsedPlotId) && parsedPlotId > 0) {
      const response = await fetch(`/get-plot-sample-geom?plotId=${parsedPlotId}`);
      if (!response.ok) {
        return Promise.reject(response);
      }
      const data = await response.json();
      plotJsonObject = data && typeof data === "object" ? data : {};
    }
    this.plotJsonObject = plotJsonObject;
    return this.buildFeatures(plotJsonObject, this.state.toggleSamples);
  };

  getVectorSource = async () => new Vector({ features: await this.getFeatures() });

  /// State

  setCenterAndZoom = (center, zoom) => {
    if (isArray(center) && isNumber(zoom)) {
      if (this.state.initCenter) {
        this.setState({
          mapCenter: center,
          mapZoom: zoom,
        });
      } else {
        this.setState({
          initCenter: center,
          initZoom: zoom,
          mapCenter: center,
          mapZoom: zoom,
        });
      }
    }
  };

  resetCenterAndZoom = () => {
    this.setCenterAndZoom(this.state.initCenter, this.state.initZoom);
  };

  /// Helpers

  extentToPolygon = (extent) => {
    const fallback = [
      [-92.25, 13.73],
      [-88.22, 13.73],
      [-88.22, 17.82],
      [-92.25, 17.82],
      [-92.25, 13.73],
    ];
    if (!extent) return fallback;
    let extentArray = null;
    try {
      extentArray = JSON.parse(decodeURIComponent(extent));
    } catch (_err) {
      try {
        extentArray = JSON.parse(decodeURI(extent));
      } catch (_err2) {
        return fallback;
      }
    }
    if (!Array.isArray(extentArray) || extentArray.length < 4) return fallback;
    return [
      [extentArray[0], extentArray[1]],
      [extentArray[2], extentArray[1]],
      [extentArray[2], extentArray[3]],
      [extentArray[0], extentArray[3]],
      [extentArray[0], extentArray[1]],
    ];
  };

  togglePlotSamples = () => {
    const nextToggle = !this.state.toggleSamples;
    const { vectorSource } = this.state;
    if (vectorSource && this.plotJsonObject) {
      const updatedFeatures = this.buildFeatures(this.plotJsonObject, nextToggle);
      vectorSource.clear(true);
      vectorSource.addFeatures(updatedFeatures);
    }
    try {
      const url = new URL(window.location.href);
      if (this.props.institutionId && !url.searchParams.get("institutionId")) {
        url.searchParams.set("institutionId", this.props.institutionId);
      }
      if (nextToggle) {
        url.searchParams.set("plotSamples", "true");
      } else {
        url.searchParams.delete("plotSamples");
      }
      window.history.replaceState({}, "", url.toString());
    } catch (_err) {
      // Ignore history errors in restricted environments
    }
    this.setState({ toggleSamples: nextToggle });
  };

  /// Render

  render() {
    const { widgets, toggleSamples } = this.state;

    return (
      <React.Fragment>
        {this.state.modal?.alert && (
          <Modal
            title={this.state.modal.alert.alertType}
            onClose={() => {
              this.setState({ modal: null });
            }}
          >
            {this.state.modal.alert.alertMessage}
          </Modal>
        )}
        <button
          style={{
            margin: "0.8rem 1.5rem",
            padding: "7px 16px",
            fontSize: "0.84rem",
            borderRadius: "8px",
          }}
          className={toggleSamples ? "btn outline" : "btn filled"}
          onClick={this.togglePlotSamples}
          type="button"
        >
          {this.state.toggleSamples
            ? "Ocultar Muestras de la Parcela"
            : "Mostrar Muestras de la Parcela"}
        </button>
        <div
          style={{
            margin: ".75rem 1.5rem 3rem",
            textAlign: "center",
            display: "grid",
            gridTemplateColumns: "repeat(12, 1fr)",
            gridAutoRows: `${gridRowHeight}px`,
            gap: ".75rem",
          }}
        >
          {widgets === null ? (
            <div
              style={{
                gridArea: "2 / 2 / span 2 / span 10",
                background: "#0d140f",
                border: "1px solid rgba(255, 255, 255, 0.08)",
                borderRadius: "16px",
                padding: "2.5rem 2rem",
                color: "#e4e4e7",
              }}
            >
              <h2 style={{ color: "#9ed999", fontSize: "1.2rem", fontWeight: 600 }}>
                Cargando configuración de Geo-Dash para este proyecto...
              </h2>
            </div>
          ) : widgets.length > 0 ? (
            widgets.map((widget, idx) => (
              <WidgetGridItem
                key={widget.id}
                idx={idx}
                imageryList={this.state.imageryList}
                initCenter={this.state.initCenter}
                mapCenter={this.state.mapCenter}
                mapZoom={this.state.mapZoom}
                plotExtentPolygon={this.extentToPolygon(this.props.plotExtent)}
                resetCenterAndZoom={this.resetCenterAndZoom}
                setCenterAndZoom={this.setCenterAndZoom}
                vectorSource={this.state.vectorSource}
                visiblePlotId={this.props.visiblePlotId}
                widget={widget}
              />
            ))
          ) : (
            <div
              style={{
                gridArea: "2 / 2 / span 2 / span 10",
                background: "#0d140f",
                border: "1px solid rgba(255, 255, 255, 0.08)",
                borderRadius: "16px",
                padding: "3rem 2rem",
                boxShadow: "0 8px 32px rgba(0, 0, 0, 0.5)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "12px",
              }}
            >
              <div
                style={{
                  width: "56px",
                  height: "56px",
                  borderRadius: "50%",
                  background: "rgba(16, 185, 129, 0.12)",
                  border: "1px solid rgba(16, 185, 129, 0.25)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "1.5rem",
                }}
              >
                🛰️
              </div>
              <h2 style={{ color: "#ffffff", fontSize: "1.25rem", fontWeight: 700, margin: 0 }}>
                No hay widgets de Geo-Dash configurados para este proyecto
              </h2>
              <p style={{ color: "#a1a1aa", fontSize: "0.92rem", maxWidth: "560px", margin: 0, lineHeight: 1.5 }}>
                Los widgets de Geo-Dash permiten consultar series de tiempo de índices espectrales (NDVI, EVI) y mosaicos satelitales multitemporales para cada parcela.
              </p>
            </div>
          )}
        </div>
      </React.Fragment>
    );
  }
}

export function pageInit(params, session) {
  ReactDOM.render(
    <>
      <GeoDashNavigationBar
        page={() => <Geodash {...params} />}
        userName={session.userName || "guest"}
        visiblePlotId={params.visiblePlotId ? parseInt(params.visiblePlotId) : -1}
      />
      <BreadCrumbs
        crumbs={[
          {
            display: "Institution",
            id: "institution",
            query: ["institution", params.institutionId],
            onClick:()=>{window.location.assign(`/review-institution?institutionId=${params.institutionId}`)}
          },
          {
            display: "Collection",
            id: "project",
            query: ["project", params.projectId],
            onClick:()=>{window.location.assign(`/collection?projectId=${params.projectId}&institutionId=${params.institutionId}`)}},
          {
            display: "Geo-Dash",
            id:"geodash"
          }]}

      />
    </>
    ,
    document.getElementById("app")
  );
}
