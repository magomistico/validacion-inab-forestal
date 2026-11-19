import React, { useContext } from "react";

import BasemapSelector from "./form/BasemapSelector";
import GDInput from "./form/GDInput";
import GDDateRange from "./form/GDDateRange";
import GDSelect from "./form/GDSelect";

import { EditorContext } from "./constants";

export default function PreImageCollectionDesigner({ isDual = false, prefixPath = "" }) {
  const { getWidgetDesign } = useContext(EditorContext);
  const currentSourceType = getWidgetDesign("sourceType", prefixPath);
  const currentSourceName = getWidgetDesign("sourceName", prefixPath);
  const availableBands = {
    Landsat: "BLUE, GREEN, RED, NIR, SWIR1, TEMP, SWIR2",
    Sentinel2: "B1, B2, B3, B4, B5, B6, B7, B8, B8A, B9, B10, B11, B12, QA10, QA20, QA60",
    "Sentinel-2": "B1, B2, B3, B4, B5, B6, B7, B8, B8A, B9, B10, B11, B12, QA10, QA20, QA60",
  };

  const sourceToItems = {
    Landsat: ["NDVI", "EVI", "EVI 2", "NDMI", "NDWI"],
    Sentinel2: ["NDVI", "EVI", "EVI 2", "NDMI", "NDWI"],
    "Sentinel-2": ["NDVI", "EVI", "EVI 2", "NDMI", "NDWI"],
  };

  return (
    <>
      {!isDual && <BasemapSelector />}
      <GDSelect
        dataKey="sourceName"
        items={["Landsat", "Sentinel-2"]}
        prefixPath={prefixPath}
        title="Imagery Source"
      />
      <GDSelect
        dataKey="sourceType"
        items={["Index", "Composite"]}
        prefixPath={prefixPath}
        title="Imagery Source Type"
      />
      <GDDateRange prefixPath={prefixPath} />
      {["Index", undefined].includes(currentSourceType) && (
        <GDSelect
          dataKey="indexName"
          items={sourceToItems[currentSourceName] || sourceToItems["Landsat"]}
          prefixPath={prefixPath}
          title="Band to graph"
        />
      )}
      {["Composite"].includes(currentSourceType) && (
        <>
          <div className="form-group mb-2">
            <label style={{ display: "block", marginBottom: "2px" }}>Available Bands:</label>
            <small style={{ color: "#9ed999", display: "block" }}>
              {availableBands[currentSourceName] || availableBands.Landsat}
            </small>
          </div>
          <GDInput
            dataKey="bands"
            placeholder={currentSourceName === "Landsat" ? "NIR,SWIR1,SWIR2" : "B8,B11,B4"}
            prefixPath={prefixPath}
            title="Bands"
          />
          <GDInput
            dataKey="min"
            placeholder="0.03,0.01,0.05 (opcional)"
            prefixPath={prefixPath}
            title="Min"
          />
          <GDInput
            dataKey="max"
            placeholder="0.45,0.5,0.4 (opcional)"
            prefixPath={prefixPath}
            title="Max"
          />
          <GDInput
            dataKey="cloudLessThan"
            placeholder="50"
            prefixPath={prefixPath}
            title="Cloud Score (% máx. nubes)"
          />
          <small style={{ color: "#a1a1aa", display: "block", marginTop: "-6px", marginBottom: "8px" }}>
            Min/Max usan reflectancia TOA (0–1); si los dejas vacíos se aplican valores recomendados.
            En zonas nubosas de Guatemala se recomienda Cloud Score entre 40 y 70.
          </small>
        </>
      )}
    </>
  );
}
