import json
import ee

from gee.utils import initialize, ensure_initialized, listAvailableBands, imageToMapId, imageCollectionToMapId, \
    filteredImageCompositeToMapId, filteredSentinelComposite, filteredSentinelSARComposite, \
    filteredImageByIndexToMapId, getFeatureCollectionTileUrl, getTimeSeriesByCollectionAndIndex, \
    getTimeSeriesByIndex, getStatistics, getDegradationPlotsByPoint, getDegradationPlotsByPointS1, \
    getDegradationTileUrlByDate, getDegradationTileUrlByDateS1, safeParseJSON, filteredNicfiCompositeToMapId
from gee.planet import getPlanetMapID
from gee.inputs import getLandsatToa, getTFO, LANDSAT_BAND_NAMES


def strtobool(val):
    if isinstance(val, bool):
        return val
    s = str(val).strip().lower()
    if s in ('y', 'yes', 't', 'true', 'on', '1'):
        return True
    if s in ('n', 'no', 'f', 'false', 'off', '0'):
        return False
    raise ValueError(f"invalid truth value {val!r}")


def safeListGet(l, idx, default=None):
    try:
        return l[idx]
    except IndexError:
        return default


def getDefault(dict, key, default=None):
    val = dict.get(key)
    if val is None or val == '':
        return default
    else:
        return val


def _coords_to_ee_geometry(coords):
    if not coords or not isinstance(coords, (list, tuple)):
        return None
    if isinstance(coords[0], (list, tuple)):
        return ee.Geometry.Polygon(coords)
    if len(coords) >= 2:
        return ee.Geometry.Point(coords[:2])
    return None


def _clean_bands_list(raw_bands, default_bands, uppercase=False):
    if isinstance(raw_bands, (list, tuple)):
        bands = [str(b).strip() for b in raw_bands if str(b).strip()]
    elif isinstance(raw_bands, str):
        bands = [b.strip() for b in raw_bands.split(',') if b.strip()]
    else:
        bands = []
    if not bands:
        bands = list(default_bands)
    if uppercase:
        bands = [b.upper() for b in bands]
    return bands

# ########## Helper routes ##########

def getAvailableBands(requestDict):
    ensure_initialized()
    values = listAvailableBands(
        getDefault(requestDict, 'assetId'),
        getDefault(requestDict, 'assetType')
    )
    return values

# ########## ee.Image ##########


def image(requestDict):
    ensure_initialized()
    values = imageToMapId(
        getDefault(requestDict, 'assetId'),
        safeParseJSON(getDefault(requestDict, 'visParams', {}))
    )
    return values

# ########## ee.ImageCollection ##########


def imageCollection(requestDict):
    ensure_initialized()
    visParams = safeParseJSON(getDefault(requestDict, 'visParams', {}))
    if visParams.get("bands") and isinstance(visParams.get("bands"), str):
        bands = visParams.get("bands").replace(' ', '')
        visParams.update({"bands": bands})
    values = imageCollectionToMapId(
        getDefault(requestDict, 'assetId', None),
        visParams,
        getDefault(requestDict, 'reducer', 'Mean'),
        getDefault(requestDict, 'startDate', None),
        getDefault(requestDict, 'endDate', None)
    )
    return values


# ########## Pre defined ee.ImageCollection ##########

def filteredLandsat(requestDict):
    ensure_initialized()
    startDate = getDefault(requestDict, 'startDate', '2020-01-01')
    endDate = getDefault(requestDict, 'endDate', '2023-01-01')
    cloud_max = float(getDefault(requestDict, 'cloudLessThan', 60))
    band_list = _clean_bands_list(
        getDefault(requestDict, 'bands', 'RED,GREEN,BLUE'),
        ['RED', 'GREEN', 'BLUE'],
        uppercase=True,
    )
    needs_indices = any(b not in LANDSAT_BAND_NAMES for b in band_list)
    collection = getLandsatToa(
        startDate,
        endDate,
        cloudFilter=cloud_max,
        computeIndices=needs_indices,
    )

    geom = getDefault(requestDict, 'geometry', None)
    if geom:
        try:
            ee_geom = _coords_to_ee_geometry(geom)
            if ee_geom is not None:
                has_scene = collection.filterBounds(ee_geom).limit(1).size().getInfo()
                if has_scene == 0:
                    cloud_label = int(cloud_max) if cloud_max.is_integer() else cloud_max
                    return {
                        'errMsg': (
                            f"No hay imágenes Landsat sobre esta parcela entre {startDate} y {endDate} "
                            f"con Cloud Score < {cloud_label}%. Sube Cloud Score (ej. 50–70) o amplía las fechas."
                        )
                    }
        except Exception as check_err:
            print(f"[WARN] No se pudo verificar cobertura Landsat en parcela: {check_err}")

    values = filteredImageCompositeToMapId(
        collection,
        {
            'min': getDefault(requestDict, 'min', '0.03,0.01,0.05'),
            'max': getDefault(requestDict, 'max', '0.45,0.5,0.4'),
            'bands': band_list,
        },
        cloud_max,
    )
    return values

def filteredNicfi(requestDict):
    ensure_initialized()
    startDate = getDefault(requestDict, 'startDate', '1990-01-01')
    endDate = getDefault(requestDict, 'endDate', '2023-01-01')
    values = filteredNicfiCompositeToMapId(
        getTFO({'start':startDate, 'end':endDate}),
        {
            'min': getDefault(requestDict, 'min', '113,113,113'),
            'max': getDefault(requestDict, 'max', '1465,1465,1465'),
            'bands': _clean_bands_list(getDefault(requestDict, 'bands', 'R,G,B'), ['R', 'G', 'B'])
        },
    )
    return values

def filteredSentinel2(requestDict):
    ensure_initialized()
    startDate = getDefault(requestDict, 'startDate', '2018-01-01')
    endDate = getDefault(requestDict, 'endDate', '2023-01-01')
    cloud_max = float(getDefault(requestDict, 'cloudLessThan', 60))
    band_list = _clean_bands_list(
        getDefault(requestDict, 'bands', 'B4,B3,B2'),
        ['B4', 'B3', 'B2'],
        uppercase=True,
    )

    geom = getDefault(requestDict, 'geometry', None)
    if geom:
        try:
            ee_geom = _coords_to_ee_geometry(geom)
            if ee_geom is not None:
                has_scene = (
                    ee.ImageCollection('COPERNICUS/S2_HARMONIZED')
                    .filterDate(startDate, endDate)
                    .filterBounds(ee_geom)
                    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', cloud_max))
                    .limit(1)
                    .size()
                    .getInfo()
                )
                if has_scene == 0:
                    cloud_label = int(cloud_max) if cloud_max.is_integer() else cloud_max
                    return {
                        'errMsg': (
                            f"No hay imágenes Sentinel-2 sobre esta parcela entre {startDate} y {endDate} "
                            f"con Cloud Score < {cloud_label}%. Sube Cloud Score (ej. 50–70) o amplía las fechas."
                        )
                    }
        except Exception as check_err:
            print(f"[WARN] No se pudo verificar cobertura Sentinel-2 en parcela: {check_err}")

    values = filteredSentinelComposite(
        {
            'min': getDefault(requestDict, 'min', '0.03,0.01,0.05'),
            'max': getDefault(requestDict, 'max', '0.45,0.5,0.4'),
            'bands': band_list,
        },
        startDate,
        endDate,
        cloud_max,
    )
    return values


# # Only used for institution imagery


def filteredSentinelSAR(requestDict):
    ensure_initialized()
    values = filteredSentinelSARComposite(
        {
            'min': getDefault(requestDict, 'min', '0'),
            'max': getDefault(requestDict, 'max', '0.3'),
            'bands': getDefault(requestDict, 'bands', 'VH,VV,VH/VV')
        },
        getDefault(requestDict, 'startDate', None),
        getDefault(requestDict, 'endDate', None)
    )
    return values


def imageCollectionByIndex(requestDict):
    ensure_initialized()
    values = filteredImageByIndexToMapId(
        getDefault(requestDict, 'startDate', '1990-01-01'),
        getDefault(requestDict, 'endDate', '2100-01-01'),
        getDefault(requestDict, 'indexName'),
        getDefault(requestDict, 'sourceName')
    )
    return values


# ########## ee.FeatureCollection ##########


# # TODO, this route inst really generic to any feature collections like the name suggests.
def featureCollection(requestDict):
    ensure_initialized()
    visParams = safeParseJSON(getDefault(requestDict, 'visParams', {}))
    values = {
        'url': getFeatureCollectionTileUrl(
            getDefault(requestDict, 'assetId', None),
            getDefault(requestDict, 'field', 'PLOTID'),
            int(getDefault(requestDict, 'matchID', 1)),
            {'max': 1, 'palette': ['red']} if visParams == {} else visParams
        )
    }
    return values

# ########## Planet ##########


def getPlanetTile(requestDict):
    values = getPlanetMapID(
        getDefault(requestDict, 'apiKey'),
        getDefault(requestDict, 'geometry'), getDefault(
            requestDict, 'startDate'),
        getDefault(requestDict, 'endDate', None),
        getDefault(requestDict, 'layerCount', 1),
        getDefault(requestDict, 'itemTypes', [
                    'PSScene3Band', 'PSScene4Band']),
        float(getDefault(requestDict, 'buffer', 0.5)),
        bool(strtobool(getDefault(requestDict, 'addsimilar', 'True')))
    )
    return values

# ########## Time Series ##########

def timeSeriesByIndex(requestDict):
    ensure_initialized()
    values = {
        'timeseries': getTimeSeriesByIndex(
            getDefault(requestDict, 'sourceName', 'Landsat'),
            getDefault(requestDict, 'indexName', 'NDVI'),
            float(getDefault(requestDict, 'scale', 30)),
            getDefault(requestDict, 'geometry', None),
            getDefault(requestDict, 'startDate', None),
            getDefault(requestDict, 'endDate', None),
            'median',
            getDefault(requestDict, 'assetId', None), # assetId is needed for the sourceName=='custom' case now
            getDefault(requestDict, 'band', None), # band is needed for the sourceName=='custom' case now


        )
    }
    return values

# ########## Degradation##########


def degradationTimeSeries(requestDict):
    ensure_initialized()
    if getDefault(requestDict, 'dataType', 'landsat') == 'landsat':
        values = {
            'timeseries': getDegradationPlotsByPoint(
                getDefault(requestDict, 'geometry'),
                getDefault(requestDict, 'startDate'),
                getDefault(requestDict, 'endDate'),
                getDefault(requestDict, 'band', 'NDFI')
            )
        }
    else:
        values = {
            'timeseries': getDegradationPlotsByPointS1(
                getDefault(requestDict, 'geometry'),
                getDefault(requestDict, 'startDate'),
                getDefault(requestDict, 'endDate')
            )
        }
    return values


def degradationTileUrl(requestDict):
    ensure_initialized()
    imageDate = getDefault(requestDict, 'imageDate', None)
    geometry = getDefault(requestDict, 'geometry')
    if getDefault(requestDict, 'degDataType', 'landsat') == 'landsat':
        stretch = getDefault(requestDict, 'stretch', 321)
        if stretch == 321:
            visParams = {'bands': 'RED,GREEN,BLUE', 'min': 0, 'max': 2000}
        elif stretch == 543:
            visParams = {'bands': 'SWIR1,NIR,RED', 'min': 0, 'max': 7000}
        elif stretch == 453:
            visParams = {'bands': 'NIR,SWIR1,RED', 'min': 0, 'max': 7000}
        values = {
            'url': getDegradationTileUrlByDate(geometry, imageDate, visParams)
        }
    else:
        values = {
            'url': getDegradationTileUrlByDateS1(
                geometry,
                imageDate,
                {
                    'bands': 'VV,VH,VV/VH',
                    'min': '-15,-25,.40',
                    'max': '0,-10,1',
                    'gamma': '1.6'
                })
        }
    return values

# ########## DynamicWorld ##########

def dynamicWorld(requestDict):
    ensure_initialized()
    geometry = getDefault(requestDict, 'geometry')
    startDate="2021-01-01"
    endDate="2022-01-01"
    visParams = safeParseJSON(getDefault(requestDict, 'visParams', {}))
    return imageCollectionToMapId("GOOGLE/DYNAMICWORLD/V1", visParams, 'Mode', startDate, endDate)


# ########## Stats ##########


def statistics(requestDict):
    ensure_initialized()
    values = getStatistics(getDefault(requestDict, 'extent', None))
    return values


# ########## AREA2 Stratification & Sampling ##########

def area2Stratification(requestDict):
    asset_id = getDefault(requestDict, 'assetId', 'projects/AREA2/public/guatemala_stratification')
    band_id = int(getDefault(requestDict, 'band', 1)) - 1
    mask_val = float(getDefault(requestDict, 'maskVal', 0))
    scale = float(getDefault(requestDict, 'scale', 30))
    palette = ['#a6cee3', '#1f78b4', '#b2df8a', '#33a02c', '#fb9a99',
               '#e31a1c', '#fdbf6f', '#ff7f00', '#cab2d6', '#6a3d9a', '#ffff99', '#b15928']
    try:
        import ee
        project = None
        if asset_id.startswith('projects/'):
            parts = asset_id.split('/')
            if len(parts) >= 2:
                project = parts[1]

        if project:
            try:
                initialize(project=project)
            except Exception:
                try:
                    ee.data.getAlgorithms()
                except Exception:
                    initialize()
        else:
            try:
                ee.data.getAlgorithms()
            except Exception:
                initialize()


        img = ee.Image(asset_id)
        try:
            img = img.select([band_id])
        except Exception:
            img = img.select([0])

        img = img.rename('classification').toInt()
        img = img.updateMask(img.neq(mask_val))

        geometry = img.geometry()
        try:
            bounds_info = geometry.bounds().coordinates().getInfo()[0]
            lons = [p[0] for p in bounds_info]
            lats = [p[1] for p in bounds_info]
            min_lon, max_lon = min(lons), max(lons)
            min_lat, max_lat = min(lats), max(lats)
            center = [(min_lon + max_lon) / 2.0, (min_lat + max_lat) / 2.0]
            bounds = [min_lon, min_lat, max_lon, max_lat]
        except Exception:
            center = [-90.2308, 15.7835]
            bounds = [-92.25, 13.73, -88.22, 17.82]

        map_id = img.getMapId({'min': 0, 'max': 12, 'palette': palette})
        tile_url = map_id['tile_fetcher'].url_format

        pixel_area = ee.Image.pixelArea().addBands(img)
        reduced = pixel_area.reduceRegion(
            reducer=ee.Reducer.sum().group(1),
            geometry=geometry,
            scale=scale,
            maxPixels=1e13,
            bestEffort=True,
            tileScale=4
        ).getInfo()

        groups = reduced.get('groups', [])
        strata_list = []
        strata_areas = []
        total_area = 0.0
        for g in groups:
            strata_list.append(int(g.get('group', 0)))
            s_val = float(g.get('sum', 0.0))
            strata_areas.append(s_val)
            total_area += s_val

        area_weights = [a / total_area for a in strata_areas] if total_area > 0 else []

        return {
            'success': True,
            'tileUrl': tile_url,
            'center': center,
            'bounds': bounds,
            'strataList': strata_list,
            'strataAreas': strata_areas,
            'areaWeights': area_weights,
            'totalArea': total_area
        }
    except Exception as e:
        err_msg = str(e)
        err_type = "UNKNOWN"
        if "not initialized" in err_msg.lower():
            err_type = "EE_AUTH_REQUIRED"
        elif "asset" in err_msg.lower() and "not found" in err_msg.lower():
            err_type = "ASSET_NOT_FOUND"
        elif "permission" in err_msg.lower() or "denied" in err_msg.lower():
            err_type = "PERMISSION_DENIED"

        return {
            'success': False,
            'errType': err_type,
            'errMsg': err_msg
        }


def area2StratifiedSample(requestDict):
    asset_id = getDefault(requestDict, 'assetId', 'projects/AREA2/public/guatemala_stratification')
    band_id = int(getDefault(requestDict, 'band', 1)) - 1
    mask_val = float(getDefault(requestDict, 'maskVal', 0))
    scale = float(getDefault(requestDict, 'scale', 30))
    class_values = requestDict.get('classValues', [])
    class_points = requestDict.get('classPoints', [])

    try:
        import ee
        project = None
        if asset_id.startswith('projects/'):
            parts = asset_id.split('/')
            if len(parts) >= 2:
                project = parts[1]

        if project:
            try:
                initialize(project=project)
            except Exception:
                try:
                    ee.data.getAlgorithms()
                except Exception:
                    initialize()
        else:
            try:
                ee.data.getAlgorithms()
            except Exception:
                initialize()


        img = ee.Image(asset_id)
        try:
            img = img.select([band_id])
        except Exception:
            img = img.select([0])

        img = img.rename('classification').toInt()
        img = img.updateMask(img.neq(mask_val))
        geometry = img.geometry()

        c_vals = [int(v) for v in class_values]
        c_pts = [int(p) for p in class_points]

        sample_fc = img.stratifiedSample(
            numPoints=0,
            classBand='classification',
            region=geometry,
            scale=scale,
            classValues=c_vals,
            classPoints=c_pts,
            geometries=True
        )

        geojson = sample_fc.getInfo()
        features = geojson.get('features', [])
        points = []
        for idx, f in enumerate(features):
            geom = f.get('geometry', {})
            coords = geom.get('coordinates', [0, 0])
            props = f.get('properties', {})
            stratum = props.get('classification', 1)
            points.append({
                'id': idx + 1,
                'lon': coords[0],
                'lat': coords[1],
                'stratum': stratum
            })

        return {
            'success': True,
            'count': len(points),
            'points': points
        }
    except Exception as e:
        return {
            'success': False,
            'errMsg': str(e)
        }


