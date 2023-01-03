// @flow

import window from '../window.js';
import mapboxgl from '../../index.js';

import type { WorkerInterface } from '../web_worker.js';
import constants from '../constants.js';

export default function (): WorkerInterface {
    let worker = (mapboxgl.workerClass != null) ? new mapboxgl.workerClass() : (new window.Worker(mapboxgl.workerUrl): any);

    worker.postMessage(constants.gl_projection);

    return worker; // eslint-disable-line new-cap
}
