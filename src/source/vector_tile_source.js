// @flow

import { Event, ErrorEvent, Evented } from '../util/evented.js';

import { extend, pick } from '../util/util.js';
import loadTileJSON from './load_tilejson.js';
import { postTurnstileEvent } from '../util/mapbox.js';
import TileBounds from './tile_bounds.js';
import { ResourceType } from '../util/ajax.js';
import browser from '../util/browser.js';
import { cacheEntryPossiblyAdded } from '../util/tile_request_cache.js';
import { DedupedRequest, loadVectorTile } from './vector_tile_worker_source.js';

import type { Source } from './source.js';
import type { OverscaledTileID } from './tile_id.js';
import type Map from '../ui/map.js';
import type Dispatcher from '../util/dispatcher.js';
import type Tile from './tile.js';
import type { Callback } from '../types/callback.js';
import type { Cancelable } from '../types/cancelable.js';
import type { VectorSourceSpecification, PromoteIdSpecification } from '../style-spec/types.js';
import type Actor from '../util/actor.js';
import type { LoadVectorTileResult } from './vector_tile_worker_source.js';

/**
 * A source containing vector tiles in [Mapbox Vector Tile format](https://docs.mapbox.com/vector-tiles/reference/).
 * (See the [Style Specification](https://docs.mapbox.com/mapbox-gl-js/style-spec/sources/#vector) for detailed documentation of options.)
 *
 * @example
 * map.addSource('some id', {
 *     type: 'vector',
 *     url: 'mapbox://mapbox.mapbox-streets-v6'
 * });
 *
 * @example
 * map.addSource('some id', {
 *     type: 'vector',
 *     tiles: ['https://d25uarhxywzl1j.cloudfront.net/v0.1/{z}/{x}/{y}.mvt'],
 *     minzoom: 6,
 *     maxzoom: 14
 * });
 *
 * @example
 * map.getSource('some id').setUrl("mapbox://mapbox.mapbox-streets-v6");
 *
 * @example
 * map.getSource('some id').setTiles(['https://d25uarhxywzl1j.cloudfront.net/v0.1/{z}/{x}/{y}.mvt']);
 * @see [Add a vector tile source](https://docs.mapbox.com/mapbox-gl-js/example/vector-source/)
 * @see [Add a third party vector tile source](https://docs.mapbox.com/mapbox-gl-js/example/third-party/)
 */
class VectorTileSource extends Evented implements Source {
    type: 'vector';
    id: string;
    minzoom: number;
    maxzoom: number;
    url: string;
    scheme: string;
    tileSize: number;
    promoteId: ?PromoteIdSpecification;
    zoomoffset: Number;

    _options: VectorSourceSpecification;
    _collectResourceTiming: boolean;
    dispatcher: Dispatcher;
    map: Map;
    bounds: ?[number, number, number, number];
    tiles: Array<string>;
    tileBounds: TileBounds;
    reparseOverscaled: boolean;
    isTileClipped: boolean;
    _tileJSONRequest: ?Cancelable;
    _loaded: boolean;
    _tileWorkers: { [string]: Actor };
    _deduped: DedupedRequest;

    constructor(id: string, options: VectorSourceSpecification & { collectResourceTiming: boolean }, dispatcher: Dispatcher, eventedParent: Evented) {
        super();
        this.id = id;
        this.dispatcher = dispatcher;

        this.type = 'vector';
        this.minzoom = 0;
        this.maxzoom = 22;
        this.scheme = 'xyz';
        this.tileSize = 512;
        this.zoomoffset = 0;
        this.reparseOverscaled = true;
        this.isTileClipped = true;
        this._loaded = false;

        extend(this, pick(options, ['url', 'scheme', 'tileSize', 'promoteId', 'zoomoffset']));
        this._options = extend({ type: 'vector' }, options);

        this._collectResourceTiming = options.collectResourceTiming;

        if (this.tileSize !== 512) {
            throw new Error('vector tile sources must have a tileSize of 512');
        }

        this.setEventedParent(eventedParent);

        this._tileWorkers = {};
        this._deduped = new DedupedRequest();
    }

    load() {
        this._loaded = false;
        this.fire(new Event('dataloading', { dataType: 'source' }));
        this._tileJSONRequest = loadTileJSON(this._options, this.map._requestManager, (err, tileJSON) => {
            this._tileJSONRequest = null;
            this._loaded = true;
            if (err) {
                this.fire(new ErrorEvent(err));
            } else if (tileJSON) {
                extend(this, tileJSON);
                if (tileJSON.bounds) this.tileBounds = new TileBounds(tileJSON.bounds, this.minzoom, this.maxzoom);
                postTurnstileEvent(tileJSON.tiles, this.map._requestManager._customAccessToken);

                // `content` is included here to prevent a race condition where `Style#_updateSources` is called
                // before the TileJSON arrives. this makes sure the tiles needed are loaded once TileJSON arrives
                // ref: https://github.com/mapbox/mapbox-gl-js/pull/4347#discussion_r104418088
                this.fire(new Event('data', { dataType: 'source', sourceDataType: 'metadata' }));
                this.fire(new Event('data', { dataType: 'source', sourceDataType: 'content' }));
            }
        });
    }

    loaded(): boolean {
        return this._loaded;
    }

    hasTile(tileID: OverscaledTileID) {
        return !this.tileBounds || this.tileBounds.contains(tileID.canonical);
    }

    onAdd(map: Map) {
        this.map = map;
        this.load();
    }

    setSourceProperty(callback: Function) {
        if (this._tileJSONRequest) {
            this._tileJSONRequest.cancel();
        }

        callback();

        const sourceCaches = this.map.style._getSourceCaches(this.id);
        for (const sourceCache of sourceCaches) {
            sourceCache.clearTiles();
        }
        this.load();
    }

    /**
     * Sets the source `tiles` property and re-renders the map.
     *
     * @param {string[]} tiles An array of one or more tile source URLs, as in the TileJSON spec.
     * @returns {VectorTileSource} this
     */
    setTiles(tiles: Array<string>) {
        this.setSourceProperty(() => {
            this._options.tiles = tiles;
        });

        return this;
    }

    /**
     * Sets the source `url` property and re-renders the map.
     *
     * @param {string} url A URL to a TileJSON resource. Supported protocols are `http:`, `https:`, and `mapbox://<Tileset ID>`.
     * @returns {VectorTileSource} this
     */
    setUrl(url: string) {
        this.setSourceProperty(() => {
            this.url = url;
            this._options.url = url;
        });

        return this;
    }

    onRemove() {
        if (this._tileJSONRequest) {
            this._tileJSONRequest.cancel();
            this._tileJSONRequest = null;
        }
    }

    serialize() {
        return extend({}, this._options);
    }

    loadTile(tile: Tile, callback: Callback<void>) {
        const url = this.map._requestManager.normalizeTileURL(tile.tileID.canonical.url(this.tiles, this.scheme, this.zoomoffset));
        const request = this.map._requestManager.transformRequest(url, ResourceType.Tile);

        const params = {
            request,
            data: undefined,
            uid: tile.uid,
            tileID: tile.tileID,
            tileZoom: tile.tileZoom,
            zoom: tile.tileID.overscaledZ,
            tileSize: this.tileSize * tile.tileID.overscaleFactor(),
            type: this.type,
            source: this.id,
            pixelRatio: browser.devicePixelRatio,
            showCollisionBoxes: this.map.showCollisionBoxes,
            promoteId: this.promoteId,
            isSymbolTile: tile.isSymbolTile
        };
        params.request.collectResourceTiming = this._collectResourceTiming;

        if (!tile.actor || tile.state === 'expired') {
            tile.actor = this._tileWorkers[url] = this._tileWorkers[url] || this.dispatcher.getActor();

            // if workers are not ready to receive messages yet, use the idle time to preemptively
            // load tiles on the main thread and pass the result instead of requesting a worker to do so
            if (!this.dispatcher.ready) {
                const cancel = loadVectorTile.call({ deduped: this._deduped }, params, (err: ?Error, data: ?LoadVectorTileResult) => {
                    if (err || !data) {
                        done.call(this, err);
                    } else {
                        // the worker will skip the network request if the data is already there
                        params.data = {
                            cacheControl: data.cacheControl,
                            expires: data.expires,
                            rawData: data.rawData.slice(0)
                        };
                        if (tile.actor) tile.actor.send('loadTile', params, done.bind(this), undefined, true);
                    }
                }, true);
                tile.request = { cancel };

            } else {
                tile.request = tile.actor.send('loadTile', params, done.bind(this), undefined, true);
            }

        } else if (tile.state === 'loading') {
            // schedule tile reloading after it has been loaded
            tile.reloadCallback = callback;

        } else {
            tile.request = tile.actor.send('reloadTile', params, done.bind(this));
        }

        function done(err, data) {
            delete tile.request;

            if (tile.aborted)
                return callback(null);

            if (err && err.status !== 404) {
                return callback(err);
            }

            if (data && data.resourceTiming)
                tile.resourceTiming = data.resourceTiming;

            if (this.map._refreshExpiredTiles && data) tile.setExpiryData(data);
            tile.loadVectorData(data, this.map.painter);

            cacheEntryPossiblyAdded(this.dispatcher);

            callback(null);

            if (tile.reloadCallback) {
                this.loadTile(tile, tile.reloadCallback);
                tile.reloadCallback = null;
            }
        }
    }

    abortTile(tile: Tile) {
        if (tile.request) {
            tile.request.cancel();
            delete tile.request;
        }
        if (tile.actor) {
            tile.actor.send('abortTile', { uid: tile.uid, type: this.type, source: this.id });
        }
    }

    unloadTile(tile: Tile) {
        tile.unloadVectorData();
        if (tile.actor) {
            tile.actor.send('removeTile', { uid: tile.uid, type: this.type, source: this.id });
        }
    }

    hasTransition() {
        return false;
    }

    afterUpdate() {
        this._tileWorkers = {};
    }
}

export default VectorTileSource;
