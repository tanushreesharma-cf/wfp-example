// Copyright (c) 2022 Cloudflare, Inc.
// Licensed under the APACHE LICENSE, VERSION 2.0 license found in the LICENSE file or at http://www.apache.org/licenses/LICENSE-2.0

import { Router } from 'itty-router';

import { AddDispatchLimits, AddOutboundWorker, FetchTable, GetDispatchLimitFromScript, GetOutboundWorkerFromScript, Initialize } from './db';
import { DISPATCH_NAMESPACE_NAME, Env } from './env';
import {
  GetScriptsByTags,
  DeleteScriptInDispatchNamespace,
  GetScriptsInDispatchNamespace,
  PutScriptInDispatchNamespace,
  PutTagsOnScript,
  GetTagsOnScript,
} from './resource';
import { ApiResponse, HtmlResponse, JsonResponse, WithCustomer, WithDB, handleDispatchError } from './router';
import { BuildTable, UploadPage } from './render';
import { DispatchLimits, IRequest, OutboundWorker, WorkerArgs } from './types';

const router = Router();

export default {
  fetch: router.handle,
};

router
  .get('/favicon.ico', () => {
    return new Response();
  })

  /*
   * Dumps the state of the app
   */
  .get('/', WithDB, async (request: IRequest, env: Env) => {
    let body = `
      <hr class="solid"><br/>
      <div>
        <form style="display: inline" action="/init"><input type="submit" value="Initialize" /></form>
        <small> - Resets db and dispatch namespace to initial state</small>
      </div>
      <h2>DB Tables</h2>`;

    /*
     * DB data
     */
    try {
      body += [
        BuildTable('customers', await FetchTable(request.db, 'customers')),
        BuildTable('customer_tokens', await FetchTable(request.db, 'customer_tokens')),
      ].join('');
    } catch (e) {
      body += '<div>No DB data. Do you need to <a href="/init">initialize</a>?</div>';
    }

    /*
     * Dispatch Namespace data
     */
    try {
      const scripts = await GetScriptsInDispatchNamespace(env);
      body += '</br><h2>Dispatch Namespace</h2>';
      body += BuildTable(DISPATCH_NAMESPACE_NAME, scripts);
    } catch (e) {
      console.log(JSON.stringify(e, Object.getOwnPropertyNames(e)));
      body += `<div>Dispatch namespace "${DISPATCH_NAMESPACE_NAME}" was not found.</div>`;
    }

    return HtmlResponse(body);
  })

  /*
   * Initialize example data
   */
  .get('/init', WithDB, async (request: IRequest, env: Env) => {
    const scripts = await GetScriptsInDispatchNamespace(env);
    await Promise.all(scripts.map(async (script) => DeleteScriptInDispatchNamespace(env, script.id)));
    await Initialize(request.db);
    return Response.redirect(request.url.replace('/init', ''));
  })

  /*
   * Where a customer can upload a script
   */
  .get('/upload', () => {
    return HtmlResponse(UploadPage);
  })

  /*
   * Gets scripts for a customer
   */
  .get('/script', WithDB, WithCustomer, async (request: IRequest, env: Env) => {
    const scripts = await GetScriptsByTags(env, [{ tag: request.customer.id, allow: true }]);
    return JsonResponse(scripts);
  })

  /*
   * Dispatch a script
   */
  .get('/dispatch/:name', WithDB, async (request: IRequest, env: Env) => {
    try {
      // TODO: doesn't work with wrangler local yet

      /*
       * look up the worker within our namespace binding.
       * Also look up any custom config tied to this script + outbound workers on this script
       * to attach to the GET call.
       *
       * this is a lazy operation. if the worker does not exist in our namespace,
       * no error will be returned until we actually try to `.fetch()` against it.
       */
      const scriptName = request.params.name;
      const dispatchLimits = (await GetDispatchLimitFromScript(request.db, scriptName)).results as unknown as DispatchLimits;
      const outboundWorker = (await GetOutboundWorkerFromScript(request.db, scriptName)).results as unknown as OutboundWorker;
      let workerArgs: WorkerArgs = {};
      const worker = env.dispatcher.get(scriptName, workerArgs, { limits: dispatchLimits});
      /*
       * call `.fetch()` on the retrieved worker to invoke it with the request.
       *
       * either `await` or `.catch()` must be used here to return a different
       * response for the 'worker not found' exception.
       */
      return worker.fetch(request).catch(handleDispatchError);
    } catch (e: unknown) {
      return handleDispatchError(e);
    }
  })

  /*
   * Uploads a customer script
   */
  .put('/script/:name', WithDB, WithCustomer, async (request: IRequest, env: Env) => {
    const scriptName = request.params.name;

    /*
     * It would be ideal to lock this block of code based on scriptName to avoid race conditions.
     * Maybe with a Durable Object?
     * https://developers.cloudflare.com/workers/runtime-apis/durable-objects/
     */

    /*
     * Check if script name exists and is owned by customer.
     * If exists and not owned, deny request.
     * If exists and owned, the request is good and means the script is being updated.
     * If not exists, it's the customer's to claim.
     */
    try {
      const tags = await GetTagsOnScript(env, scriptName);
      if (tags.length > 0 && !tags.includes(request.customer.id)) {
        return ApiResponse('Script name already reserved', 409);
      }
    } catch (e) {
      return ApiResponse('Could not complete request', 500);
    }

    /*
     * Get script content and limits from request.
     */
    let scriptContent: string;
    let limits: DispatchLimits;
    //let outbound: OutboundWorker;
    try {
      const data: {
        script: string;
        dispatch_config: {
          limits?: { cpuMs: number; memory: number };
          //outbound: string;
        };
      } = (await request.json()) as {
        script: string;
        dispatch_config: {
          limits?: { cpuMs: number; memory: number };
          //outbound: string;
        };
      };

      scriptContent = data.script;
      limits = { script_id: scriptName, ...data.dispatch_config.limits };
      //outbound = { script_id: scriptName, outbound_script_id: data.dispatch_config.outbound };
    } catch (e) {
      return ApiResponse('Expected json: { script: string, dispatch_config: { limits?: { cpuMs: number, memory: number }, outbound: string }}', 400);
    }

    /*
     * Upload the script to the dispatch namespace.
     * On error, forward the response from the dispatch namespace API
     * since it gives necessary feedback to the customer.
     */
    const scriptResponse = await PutScriptInDispatchNamespace(env, scriptName, scriptContent);
    if (!scriptResponse.ok) {
      return JsonResponse(await scriptResponse.json(), 400);
    }

    /*
     * Persist the dispatch limits (if any) in d1 with the scriptName as primary key
     */
    if (limits.cpuMs || limits.memory) await AddDispatchLimits(request.db, limits);

    /*
     * Persist the outbound worker in d1 with scriptName as primary key
     * In practice you will need to add more params with the outbound worker, refer
     * to our documentation here: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/platform/outbound-workers/
     */
    //if (outbound?.outbound_script_id !== '') {
      //await AddOutboundWorker(request.db, outbound);
    //}

    /*
     * Add customer_id and plan_type as script tags.
     * If that errors, something is wrong so log it!
     * Could add logic to delete script if that's immediately problematic.
     */
    const tagsResponse = await PutTagsOnScript(env, scriptName, [request.customer.id, request.customer.plan_type]);
    if (!tagsResponse.ok) {
      console.log(tagsResponse.url, tagsResponse.status, await tagsResponse.text());
    }

    return ApiResponse('Success', 201);
  })

  /*
   * Gracefully handle undefined routes.
   */
  .all('*', (request) => {
    return new Response(`Could not route from url: ${request.url}`, { status: 404 });
  });
