import datetime
import os
import ee
import math
import sys
import json
from ee.ee_exception import EEException
from gee.inputs import getLandsat, getS1, getLandsatToa, getTFO, getSentinel2Toa, calcNDVI, calcEVI, calcEVI2, calcNDMI, calcNDWI


########## Helper functions ##########

_LAST_INIT_ERROR = ''


def _credentials_dirs():
    dirs = []
    home_dir = os.path.expanduser('~')
    if home_dir:
        dirs.append(os.path.join(home_dir, '.config', 'earthengine'))
    root_dir = '/root/.config/earthengine'
    if root_dir not in dirs:
        dirs.append(root_dir)
    return dirs


def _read_json_field(file_path, keys):
    if not file_path or not os.path.exists(file_path):
        return None
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data, dict):
            for key in keys:
                val = data.get(key)
                if isinstance(val, str) and val.strip():
                    return val.strip()
    except Exception:
        pass
    return None


def _resolve_ee_project(project=None, sa_key=''):
    if isinstance(project, str) and project.strip():
        return project.strip()

    for env_key in ('EE_PROJECT', 'GEE_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT'):
        env_val = os.environ.get(env_key, '').strip()
        if env_val:
            return env_val

    sa_project = _read_json_field(sa_key, ('project_id', 'project'))
    if sa_project:
        return sa_project

    for cred_dir in _credentials_dirs():
        cred_project = _read_json_field(
            os.path.join(cred_dir, 'credentials'),
            ('project', 'quota_project_id', 'project_id'),
        )
        if cred_project:
            return cred_project

    for cred_dir in _credentials_dirs():
        cached_path = os.path.join(cred_dir, 'inab_default_project')
        if os.path.exists(cached_path):
            try:
                with open(cached_path, 'r', encoding='utf-8') as f:
                    cached = f.read().strip()
                if cached:
                    return cached
            except Exception:
                pass

    return None


def save_default_project(project):
    if not isinstance(project, str):
        return
    clean_proj = project.strip()
    if not clean_proj or clean_proj.upper() == 'AREA2':
        return
    for cred_dir in _credentials_dirs():
        if os.path.isdir(cred_dir):
            try:
                with open(os.path.join(cred_dir, 'inab_default_project'), 'w', encoding='utf-8') as f:
                    f.write(clean_proj)
                return
            except Exception:
                pass


def initialize(ee_account='', ee_key_path='', project=None):
    global _LAST_INIT_ERROR
    try:
        sa_key = ee_key_path or os.environ.get('GOOGLE_APPLICATION_CREDENTIALS', '')
        if not sa_key and os.path.exists('/app/ee-key.json'):
            sa_key = '/app/ee-key.json'

        resolved_project = _resolve_ee_project(project=project, sa_key=sa_key)

        if sa_key and os.path.exists(sa_key):
            try:
                if ee_account:
                    credentials = ee.ServiceAccountCredentials(ee_account, sa_key)
                else:
                    credentials = ee.ServiceAccountCredentials.from_json_file(sa_key)
                if resolved_project:
                    ee.Initialize(credentials, project=resolved_project)
                else:
                    ee.Initialize(credentials)
                _LAST_INIT_ERROR = ''
                save_default_project(resolved_project)
                print(f"[INFO] GEE Inicializado con Service Account ({sa_key}, project={resolved_project or 'default'})")
                return True
            except Exception as sa_err:
                print(f"[WARN] Error inicializando SA {sa_key}: {sa_err}")

        kwargs = {}
        if resolved_project:
            kwargs['project'] = resolved_project
        ee.Initialize(**kwargs)
        _LAST_INIT_ERROR = ''
        save_default_project(resolved_project)
        print(f"[INFO] GEE Inicializado exitosamente (project={resolved_project or 'default'})")
        return True
    except Exception as e:
        _LAST_INIT_ERROR = str(e)
        print(f"[WARN] Error en ee.Initialize: {e}")
        return False


def ensure_initialized(project=None):
    if project:
        if initialize(project=project):
            return True
    else:
        has_creds = getattr(ee.data, '_credentials', None) is not None
        active_proj = getattr(ee.data, '_cloud_api_user_project', None)
        if has_creds and (not active_proj or str(active_proj).upper() != 'AREA2'):
            return True
        if initialize():
            return True
        if has_creds:
            return True

    err_lower = (_LAST_INIT_ERROR or '').lower()
    if 'no project found' in err_lower or 'project' in err_lower and 'not' in err_lower:
        raise EEException(
            "Google Earth Engine requiere un proyecto de Cloud por defecto. "
            "Ejecuta en el servidor: sudo docker compose exec -it app earthengine set_project TU_PROYECTO_GEE"
        )
    if 'authorize' in err_lower or 'credentials' in err_lower or 'not found' in err_lower:
        raise EEException(
            "Google Earth Engine no está autenticado en el servidor. "
            "Ejecuta: sudo docker compose exec -it app earthengine authenticate --auth_mode=notebook "
            "y luego: sudo docker compose exec -it app earthengine set_project TU_PROYECTO_GEE"
        )
    raise EEException(
        f"No se pudo inicializar Google Earth Engine: {_LAST_INIT_ERROR or 'verifica credenciales y proyecto GEE.'}"
    )


def _parse_numeric_vis_param(val):
    if isinstance(val, (int, float)):
        return val
    if isinstance(val, (list, tuple)):
        parsed = []
        for item in val:
            if item is None or str(item).strip() == '':
                continue
            parsed.append(float(item))
        if not parsed:
            return None
        return parsed[0] if len(parsed) == 1 else parsed
    if isinstance(val, str):
        parts = [p.strip() for p in val.split(',') if p.strip() != '']
        if not parts:
            return None
        nums = [float(p) for p in parts]
        return nums[0] if len(nums) == 1 else nums
    return val


def normalizeVisParams(visParams):
    if not isinstance(visParams, dict):
        return {}
    normalized = dict(visParams)

    if 'bands' in normalized:
        bands = normalized['bands']
        if isinstance(bands, str):
            band_list = [b.strip() for b in bands.split(',') if b.strip()]
            if band_list:
                normalized['bands'] = band_list
            else:
                normalized.pop('bands', None)
        elif isinstance(bands, (list, tuple)):
            band_list = [str(b).strip() for b in bands if str(b).strip()]
            if band_list:
                normalized['bands'] = band_list
            else:
                normalized.pop('bands', None)

    for num_key in ('min', 'max', 'gamma', 'gain', 'bias'):
        if num_key in normalized:
            try:
                parsed = _parse_numeric_vis_param(normalized[num_key])
                if parsed is None:
                    normalized.pop(num_key, None)
                else:
                    normalized[num_key] = parsed
            except (TypeError, ValueError):
                pass

    if 'palette' in normalized:
        palette = normalized['palette']
        if isinstance(palette, str):
            colors = [c.strip() for c in palette.split(',') if c.strip()]
            if colors:
                normalized['palette'] = colors
            else:
                normalized.pop('palette', None)

    return normalized


def getReducer(reducer):
    reducerName = reducer.lower()
    if(reducerName == 'min'):
        return ee.Reducer.min()
    elif (reducerName == 'max'):
        return ee.Reducer.max()
    elif (reducerName == 'mean'):
        return ee.Reducer.mean()
    elif (reducerName == 'mode'):
        return ee.Reducer.mode()
    elif (reducerName == 'first'):
        return ee.Reducer.first()
    elif (reducerName == 'last'):
        return ee.Reducer.last()
    elif (reducerName == 'sum'):
        return ee.Reducer.sum()
    else:
        return ee.Reducer.median()


def reduceIC(imageCollection, reducer):
    reducerName = reducer.lower()
    if(reducerName == 'min'):
        return imageCollection.min()
    elif (reducerName == 'max'):
        return imageCollection.max()
    elif (reducerName == 'mean'):
        return imageCollection.mean()
    elif (reducerName == 'mode'):
        return imageCollection.mode()
    elif (reducerName == 'mosaic'):
        return imageCollection.mosaic()
    elif (reducerName == 'first'):
        return imageCollection.first()
    elif (reducerName == 'sum'):
        return imageCollection.sum()
    else:
        return imageCollection.median()


def safeParseJSON(val):
    if isinstance(val,  dict):
        return val
    else:
        try:
            return json.loads(val)
        except Exception as e:
            try:
                return json.loads(val.replace("'", "\""))
            except Exception as e:
                return {}


def validateJSON(image, params):
    try:
        ensure_initialized()
        dummy_img = ee.Image(image)
        if params:
            visd_img = dummy_img.visualize(**normalizeVisParams(params))
            vis_info = visd_img.getInfo()
        return None
    except Exception as e:
        return str(e)


'''def sanitize_vis_params(vis_params):
    """Clean and validate visParams before use"""
    valid_params = {}
    
    # Validate bands parameter
    if 'bands' in vis_params:
        bands = vis_params['bands']
        if isinstance(bands, (list, tuple)) and all(isinstance(b, str) for b in bands):
            valid_params['bands'] = list(bands)
    
    # Validate min/max
    if 'min' in vis_params and 'max' in vis_params:
        try:
            valid_params['min'] = float(vis_params['min'])
            valid_params['max'] = float(vis_params['max'])
        except (TypeError, ValueError):
            pass  # Skip invalid min/max
    
    # Validate palette (accepts list of colors or CSS string)
    if 'palette' in vis_params:
        palette = vis_params['palette']
        if isinstance(palette, (list, tuple)):
            valid_params['palette'] = list(palette)
        elif isinstance(palette, str):
            valid_params['palette'] = palette
    
    # Add other parameters you want to support
    for param in ['gamma', 'opacity', 'gain']:
        if param in vis_params:
            try:
                valid_params[param] = float(vis_params[param])
            except (TypeError, ValueError):
                pass
    
    return valid_params'''

########## Helper routes ##########


def listAvailableBands(name, assetType):
    eeImage = None
    if assetType == "imageCollection":
        eeImage = ee.ImageCollection(name).first()
    else:
        eeImage = ee.Image(name)
    return {
        'bands': eeImage.bandNames().getInfo(),
        'imageName': name
    }

########## ee.Image ##########


def imageToMapId(image, visParams):
    eeImage = ee.Image(image)
    mapId = eeImage.getMapId(normalizeVisParams(visParams))
    # TODO, just return URL so the routes are easier to deduce whats being returned.
    return {
        'url': mapId['tile_fetcher'].url_format
    }

########## ee.ImageCollection ##########


def imageCollectionToMapId(assetId, visParams, reducer, startDate, endDate):
    eeCollection = ee.ImageCollection(assetId)
    if (startDate and endDate):
        eeFilterDate = ee.Filter.date(startDate, endDate)
        eeCollection = eeCollection.filter(eeFilterDate)

    reducedImage = ee.Image(reduceIC(eeCollection, reducer))
    return imageToMapId(reducedImage, visParams)

# TODO, should we allow user to select first cloud free image again?


def firstCloudFreeImageInMosaicToMapId(assetId, visParams, startDate, endDate):
    skipCloudMask = False
    eeCollection = ee.ImageCollection(assetId)
    lowerAsset = assetId.lower()
    if("b2" not in visParams["bands"].lower()):
        skipCloudMask = True
    elif ("lc8" in lowerAsset):
        skipCloudMask = False
    elif ("le7" in lowerAsset):
        skipCloudMask = False
    elif ("lt5" in lowerAsset):
        skipCloudMask = False
    else:
        skipCloudMask = True
    if (startDate and endDate):
        eeFilterDate = ee.Filter.date(startDate, endDate)
        eeCollection = eeCollection.filter(eeFilterDate)
    eeFirstImage = ee.Image(eeCollection.mosaic())
    try:
        if(skipCloudMask == False):
            sID = ''
            if ("lc8" in lowerAsset):
                sID = 'OLI_TIRS'
            elif ("le7" in lowerAsset):
                sID = 'ETM'
            elif ("lt5" in lowerAsset):
                sID = 'TM'
            scored = ee.Algorithms.Landsat.simpleCloudScore(
                eeFirstImage.set('SENSOR_ID', sID))
            mask = scored.select(['cloud']).lte(20)
            masked = eeFirstImage.updateMask(mask)
            values = imageToMapId(masked, visParams)
        else:
            values = imageToMapId(eeFirstImage, visParams)
    except EEException as ine:
        imageToMapId(eeFirstImage, visParams)
    return values

########## ee.FeatureCollection ##########


def getFeatureCollectionTileUrl(featureCollection, field, matchID, visParams):
    fc = ee.FeatureCollection(featureCollection)
    single = fc.filter(ee.Filter.equals(field, matchID))
    mapId = ee.Image().paint(single, 0, 2).getMapId(normalizeVisParams(visParams))
    return mapId['tile_fetcher'].url_format

########## Pre defined ee.ImageCollection ##########

# Index Image Collection


def getLandSatMergedCollection(startDate, endDate):
    # note originally only used LS T1. New call is same as time series
    #  which pulls T1 & T2. Ask if we want this. 
    ls = getLandsatToa(**{'startDate':startDate, 'endDate':endDate})
    s2 = getSentinel2Toa({'adjustBands':True})
    return ls.merge(s2)


def filteredImageNDVIToMapId(startDate, endDate, source):
    eeCollection = filteredCollectionBySourceName(startDate, endDate, source)
    colorPalette = 'c9c0bf,435ebf,eee8aa,006400'
    visParams = {'opacity': 1, 'max': 1,
                 'min': -1, 'palette': colorPalette}
    image = eeCollection.select('NDVI').mean()
    return imageToMapId(image, visParams)


def filteredImageEVIToMapId(startDate, endDate, source):
    eeCollection = filteredCollectionBySourceName(startDate, endDate, source)
    colorPalette = 'F5F5F5,E6D3C5,C48472,B9CF63,94BF3D,6BB037,42A333,00942C,008729,007824,004A16'
    visParams = {'opacity': 1, 'max': 1,
                 'min': -1, 'palette': colorPalette}
    image = eeCollection.select('EVI').mean()
    return imageToMapId(image, visParams)


def filteredImageEVI2ToMapId(startDate, endDate, source):
    eeCollection = filteredCollectionBySourceName(startDate, endDate, source)
    colorPalette = 'F5F5F5,E6D3C5,C48472,B9CF63,94BF3D,6BB037,42A333,00942C,008729,007824,004A16'
    visParams = {'opacity': 1, 'max': 1,
                 'min': -1, 'palette': colorPalette}
    image = eeCollection.select('EVI2').mean()
    return imageToMapId(image, visParams)


def filteredImageNDMIToMapId(startDate, endDate, source):
    eeCollection = filteredCollectionBySourceName(startDate, endDate, source)
    colorPalette = '0000FE,2E60FD,31B0FD,00FEFE,50FE00,DBFE66,FEFE00,FFBB00,FF6F00,FE0000'
    visParams = {'opacity': 1, 'max': 1,
                 'min': -1, 'palette': colorPalette}
    image = eeCollection.select('NDMI').mean()
    return imageToMapId(image, visParams)


def filteredImageNDWIToMapId(startDate, endDate, source):
    eeCollection = filteredCollectionBySourceName(startDate, endDate, source)
    colorPalette = '505050,E8E8E8,00FF33,003300'
    visParams = {'opacity': 1, 'max': 1,
                 'min': -1, 'palette': colorPalette}
    image = eeCollection.select('NDWI').mean()
    return imageToMapId(image, visParams)

def filteredCollectionBySourceName(startDate, endDate, source):
    collection = None
    lower_source = (source or '').lower()
    if lower_source == 'landsat':
        collection = getLandsatToa(**{'startDate':startDate, 'endDate':endDate})
    elif lower_source in ('sentinel2', 'sentinel-2'):
        collection =  getSentinel2Toa({'start':startDate, 'end':endDate})
    elif lower_source == 'tfo':
        collection = getTFO({'start':startDate, 'end':endDate})
    
    return collection

def filteredImageByIndexToMapId(startDate, endDate, index, source):
    lowerIndex = index.lower()
    lowerSource = source.lower()
    if (lowerIndex == 'ndvi'):
        return filteredImageNDVIToMapId(startDate, endDate, lowerSource)
    elif (lowerIndex == 'evi'):
        return filteredImageEVIToMapId(startDate, endDate, lowerSource)
    elif (lowerIndex == 'evi2'):
        return filteredImageEVI2ToMapId(startDate, endDate, lowerSource)
    elif (lowerIndex == 'ndmi'):
        return filteredImageNDMIToMapId(startDate, endDate, lowerSource)
    elif (lowerIndex == 'ndwi'):
        return filteredImageNDWIToMapId(startDate, endDate, lowerSource)


def filteredImageCompositeToMapId(eeCollection, visParams, metadataCloudCoverMax):
    # todo: rename, this is only used for landsat
    eeCollection = eeCollection.filter(
        ee.Filter.lt('CLOUD_COVER', float(metadataCloudCoverMax))
    )
    eeMosaicImage = medoid(eeCollection, ['BLUE', 'GREEN', 'RED', 'NIR', 'SWIR1', 'SWIR2'])

    return imageToMapId(eeMosaicImage, visParams)


def filteredNicfiCompositeToMapId(eeCollection, visParams):
    eeMosaicImage = medoid(eeCollection,  ['B','G','R','N'])

    return imageToMapId(eeMosaicImage, visParams)


def filteredSentinelComposite(visParams, startDate, endDate, metadataCloudCoverMax):
    def scaleAndCloudScore(img):
        rescale = img.divide(10000)
        score = ee.Image(1).subtract(cloudScoreSentinel2(rescale)).rename('cloudscore')
        return rescale.addBands(score)

    sentinel2 = ee.ImageCollection('COPERNICUS/S2_HARMONIZED')
    f2017s2 = sentinel2.filterDate(startDate, endDate).filter(
        ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', float(metadataCloudCoverMax)))
    m2017s2 = f2017s2.map(scaleAndCloudScore)
    m2017s3 = m2017s2.qualityMosaic('cloudscore')
    return imageToMapId(m2017s3, visParams)


def filteredSentinelSARComposite(visParams, startDate, endDate):
    def toNatural(img):
        return ee.Image(10).pow(img.divide(10))

    def addRatioBands(img):
        # not using angle band
        vv = img.select('VV')
        vh = img.select('VH')
        vv_vh = vv.divide(vh).rename('VV/VH')
        vh_vv = vh.divide(vv).rename('VH/VV')
        return vv.addBands(vh).addBands(vv_vh).addBands(vh_vv)

    sentinel1 = ee.ImageCollection('COPERNICUS/S1_GRD')
    sentinel1 = sentinel1.filterDate(startDate, endDate) \
        .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV')) \
        .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH')) \
        .filter(ee.Filter.eq('instrumentMode', 'IW'))

    sentinel1 = sentinel1.map(toNatural)
    sentinel1 = sentinel1.map(addRatioBands)
    median = sentinel1.median()
    return imageToMapId(median, visParams)


def cloudScoreLandsat(img):
    def rescale(img, exp, thresholds):
        return img.expression(exp, {'img': img}).subtract(thresholds[0]).divide(thresholds[1] - thresholds[0])

    score = ee.Image(1.0)
    score = score.min(rescale(img, 'img.BLUE', [0.1, 0.3]))
    score = score.min(rescale(img, 'img.RED + img.GREEN + img.BLUE', [0.2, 0.8]))
    score = score.min(
        rescale(img, 'img.NIR + img.SWIR1 + img.SWIR2', [0.3, 0.8]))
    # // Clouds are reasonably cool in temperature.
    score = score.min(rescale(img, 'img.TEMP', [300, 290]))
    ndsi = img.normalizedDifference(['GREEN', 'SWIR1'])
    score = score.min(rescale(ndsi, 'img', [0.8, 0.6]))
    score = ee.Image(1).subtract(score).rename('cloudscore')

    return img.addBands(score)


def cloudScoreSentinel2(img):
    def rescale(img, exp, thresholds):
        return img.expression(exp, {'img': img}).subtract(thresholds[0]).divide(thresholds[1] - thresholds[0])

    score = ee.Image(1.0)
    score = score.min(rescale(img, 'img.B2', [0.1, 0.3]))
    score = score.min(rescale(img, 'img.B4 + img.B3 + img.B2', [0.2, 0.8]))
    score = score.min(
        rescale(img, 'img.B8 + img.B11 + img.B12', [0.3, 0.8]))
    ndsi = img.normalizedDifference(['B3', 'B11'])
    return score.min(rescale(ndsi, 'img', [0.8, 0.6]))


def medoid(collection, distance_bands):
    median_img = collection.select(distance_bands).median()

    def prepareMedoid(image):
        diff = image.select(distance_bands).subtract(median_img)
        distance = (
            diff.pow(2)
            .reduce(ee.Reducer.sum())
            .sqrt()
            .multiply(-1)
            .rename('distanceToMedian')
        )
        return image.addBands(distance)

    return collection.map(prepareMedoid).qualityMosaic('distanceToMedian')

    
########## Time Series ##########


def getTimeSeriesByCollectionAndIndex(assetId, indexName, scale, coords, startDate, endDate, reducer):
    geometry = None
    indexCollection = None
    if isinstance(coords[0], list):
        geometry = ee.Geometry.Polygon(coords)
    else:
        geometry = ee.Geometry.Point(coords)
    if indexName != None:
        indexCollection = ee.ImageCollection(assetId).filterDate(
            startDate, endDate).select(indexName)
    else:
        indexCollection = ee.ImageCollection(
            assetId).filterDate(startDate, endDate)

    def getIndex(image):
        theReducer = getReducer(reducer)
        if indexName != None:
            indexValue = image.reduceRegion(
                theReducer, geometry, scale).get(indexName)
        else:
            indexValue = image.reduceRegion(theReducer, geometry, scale)
        date = image.get('system:time_start')
        indexImage = ee.Image().set(
            'indexValue', [ee.Number(date), indexValue])
        return indexImage

    def getClipped(image):
        return image.clip(geometry)

    clippedcollection = indexCollection.map(getClipped)
    indexCollection1 = clippedcollection.map(getIndex)
    indexCollection2 = indexCollection1.aggregate_array('indexValue')
    return indexCollection2.getInfo()


def getTimeSeriesByIndex(sourceName, indexName, scale, coords, startDate, endDate, reducer, assetId, band):
 
    def reduceRegion(image):
        theReducer = getReducer(reducer)
        reduced = image.reduceRegion(
            theReducer, geometry=geometry, scale=scale, maxPixels=1e6, bestEffort=True)
        return ee.Feature(None, {
            'index': reduced.get('index'),
            'timeIndex': [image.get('system:time_start'), reduced.get('index')]
        })

    geometry = None
    if isinstance(coords[0], list) or isinstance(coords[0], tuple):
        geometry = ee.Geometry.Polygon(coords)
    else:
        geometry = ee.Geometry.Point(coords)

    if sourceName.lower() == 'landsat':
        collection = (getLandsatToa(startDate, endDate, geometry)
                      .select([indexName],['index']))
    elif sourceName.lower() == 'nicfi':
        collection = getTFO({
            'start':startDate,
            'end':endDate
        }).select([indexName],['index'])
    elif sourceName.lower() == "custom":
        collection = (ee.ImageCollection(assetId)
                      .filterBounds(geometry).filterDate(startDate, endDate)).select([band],['index'])
    else:
        raise ValueError(f'imagery source {sourceName} is not implemented.') 
   
    result = ee.ImageCollection(ee.ImageCollection(collection).sort('system:time_start') \
        .distinct('system:time_start')) \
        .map(reduceRegion) \
        .filter(ee.Filter.neq('index', None)) \
        .aggregate_array('timeIndex') \
        .getInfo()

    return result

########## Degradation##########

def getDegradationTileUrlByDateS1(geometry, date, visParams):
    imDate = datetime.datetime.strptime(date, "%Y-%m-%d")
    befDate = imDate - datetime.timedelta(days=1)
    aftDate = imDate + datetime.timedelta(days=1)

    if isinstance(geometry[0], list):
        geometry = ee.Geometry.Polygon(geometry)
    else:
        geometry = ee.Geometry.Point(geometry)

    sentinel1Data = getS1({
        "targetBands": ['VV', 'VH', 'VV/VH'],
        'region': geometry})

    start = befDate.strftime('%Y-%m-%d')
    end = aftDate.strftime('%Y-%m-%d')

    selectedImage = sentinel1Data.filterDate(start, end).first()

    selectedImage = ee.Image(selectedImage)
    mapparams = selectedImage.getMapId(visParams)
    return mapparams['tile_fetcher'].url_format


def getDegradationPlotsByPointS1(geometry, start, end):
    if isinstance(geometry[0], list):
        geometry = ee.Geometry.Polygon(geometry)
    else:
        geometry = ee.Geometry.Point(geometry)

    sentinel1Data = getS1({
        "targetBands": ['VV', 'VH', 'VV/VH'],
        'region': geometry
    }).filterDate(start, end)

    def myimageMapper(img):
        theReducer = ee.Reducer.mean()
        indexValue = img.reduceRegion(theReducer, geometry, 30)
        date = img.get('system:time_start')
        visParams = {'bands': ['VV', 'VH', 'ratioVVVH'],
                     'min': [-15, -25, .40], 'max': [0, -10, 1], 'gamma': 1.6}
        indexImage = ee.Image().set(
            'indexValue', [ee.Number(date), indexValue])
        return indexImage
    lsd = sentinel1Data.map(myimageMapper, True)
    indexCollection2 = lsd.aggregate_array('indexValue')
    values = indexCollection2.getInfo()
    return values


def getDegradationTileUrlByDate(geometry, date, visParams):
    imDate = datetime.datetime.strptime(date, "%Y-%m-%d")
    startDate = imDate - datetime.timedelta(days=1)
    endDate = imDate + datetime.timedelta(days=1)
    if isinstance(geometry[0], list):
        geometry = ee.Geometry.Polygon(geometry)
    else:
        geometry = ee.Geometry.Point(geometry)

    landsatData = getLandsatToa(
        startDate.strftime('%Y-%m-%d'),
        endDate.strftime('%Y-%m-%d'),
        geometry
    )

    selectedImage = landsatData.first()
    unmasked = ee.Image(selectedImage).multiply(10000).toInt16().unmask()
    mapparams = unmasked.getMapId(visParams)
    return mapparams['tile_fetcher'].url_format


def getDegradationPlotsByPoint(geometry, start, end, band):
    if isinstance(geometry[0], list):
        geometry = ee.Geometry.Polygon(geometry)
    else:
        geometry = ee.Geometry.Point(geometry)

    landsatData = getLandsatToa(start, end, geometry)

    def myImageMapper(img):
        theReducer = ee.Reducer.mean()
        indexValue = img.reduceRegion(theReducer, geometry, 30)
        date = img.get('system:time_start')
        indexImage = ee.Image().set(
            'indexValue',
            [ee.Number(date), indexValue]
        )
        return indexImage
    lsd = landsatData.map(myImageMapper, True)
    indexCollection2 = lsd.aggregate_array('indexValue')
    values = indexCollection2.getInfo()
    return values


########## Stats ##########

def getStatistics(extent):
    extentGeom = ee.Geometry.Polygon(extent)
    elevation = ee.Image('USGS/GTOPO30')
    population = ee.ImageCollection("CIESIN/GPWv411/GPW_Population_Count").sort('system:time_start',False).first()

    def reduceElev():
        minmaxElev = elevation.reduceRegion(**{
            'reducer':ee.Reducer.minMax(),
            'geometry' :extentGeom, 
            'scale':30,
            'bestEffort':True, 
            'maxPixels':1e13
            
        })

        return ee.Dictionary({
            'minElev': minmaxElev.get('elevation_min'),
            'maxElev': minmaxElev.get('elevation_max'),
        })
    
    def reducePop ():
        popDict = population.reduceRegion(**{
            'reducer':ee.Reducer.sum().unweighted(),
            'geometry': extentGeom, 
            'maxPixels':1e13,
            'scale':927.67  
        })
        pop = ee.Number(popDict.get('population_count')).int()
        return ee.Dictionary({'pop':pop})

    def sampleElve():
        centriod = extentGeom.centroid(1)
        sampleElv =  elevation.reduceRegion(**{
            'reducer':ee.Reducer.first(),
            'geometry': centriod, 
            'maxPixels':1e13,
            'scale':30  
        })
        return ee.Dictionary({
            'minElev': sampleElv.get('elevation'),
            'maxElev': sampleElv.get('elevation'),
        })

    def samplePop():
        centriod = extentGeom.centroid(1)
        sample = population.reduceRegion(**{
            'reducer':ee.Reducer.first(),
            'geometry': centriod, 
            'maxPixels':1e13,
            'scale':927.67  
        })
        pop = ee.Number(sample.get('population_count')).int()
        return ee.Dictionary({'pop':pop})

    # ~900m = 30m2
    conditionSampleElev = extentGeom.area(1).lt(900).getInfo()
    # ~859,329m = 927.67m2
    conditionSamplePop = extentGeom.area(1).lt(860000).getInfo()
    
    if conditionSampleElev:
        elevationResults = sampleElve()
    else:
        elevationResults = reduceElev()
    
    if conditionSamplePop:
        populationResults = samplePop()
    else:
        populationResults = reducePop()

    return elevationResults.combine(populationResults).getInfo()
