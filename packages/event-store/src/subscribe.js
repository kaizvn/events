/* @flow */
import kefir from 'kefir';
import mitt from 'mitt';
import once from 'lodash/fp/once';
import range from 'lodash/fp/range';

// import { parse } from 'querystring';
import { query } from './query';

import { createClient } from './redis-client';
import type { SubscribeConfig } from '../types/Config.type';

const tryParse = raw => {
  try {
    return JSON.parse(raw);
  } catch (ex) {
    return { type: '@@RAW', payload: raw };
  }
};

function flush(response) {
  if (response.flush && response.flush.name !== 'deprecated') {
    response.flush();
  }
}

const toOutput = events => `id: ${events[0].id}
event: INCMSG
data: ${JSON.stringify(events)}

`;

export default ({ redis, history, debug, namespc, burst }: SubscribeConfig) => {
  const subClient = createClient(redis);

  // prepare cache
  const MAX_SIZE = history.size;
  const list = [];
  const cache = {};

  const addToCache = message => {
    debug && console.log('adding to cache', message.id);

    const newSize = list.unshift(message.id);
    cache[message.id] = message;

    debug && console.log('HISTORY', list);
    debug && console.log('CACHE', cache);

    if (newSize > MAX_SIZE) {
      const expired = list.splice(MAX_SIZE);
      expired.forEach(removingId => {
        delete cache[removingId];
      });
    }
  };

  const message$ = kefir
    .fromEvents(subClient, 'message', (channel, message) => message)
    .map(message => {
      const rawId = message.split(':')[0];
      const id = Number(rawId);
      const rawEvent = message.slice(rawId.length + 1);

      return {
        id,
        ...tryParse(rawEvent),
      };
    })
    .onValue(addToCache);

  const addClient = (src, opts, match, req, res) => {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream;charset=UTF-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    res.write(':ok\n\n');

    if (opts.initial.length) {
      res.write(toOutput(opts.initial));
    }

    // cast to integer
    const retry = opts.retry | 0;

    if (retry) {
      res.write('retry: ' + retry + '\n');
    }

    flush(res);

    const subscription = src
      .filter(x => x)
      .bufferWithTimeOrCount(burst.time, burst.count)
      .filter(b => b.length)
      .map(toOutput)
      .observe(block => {
        debug && console.log('send to %s %s', req.url, block);
        res.write(block);
      });

    const removeClient = once(() => {
      debug && console.log('removing', req.url);
      subscription.unsubscribe();
      res.end();
    });

    req.on('end', removeClient);
    req.on('close', removeClient);
    res.on('finish', removeClient);
  };

  const getInitialValues = lastEventId => {
    if (lastEventId) {
      // history[0] is the latest id
      const current = list[0];
      const oldestInCache = list[list.length - 1];
      if (oldestInCache > lastEventId + 1) {
        console.error('too old');
      }

      debug && console.log('current', current);
      return range(lastEventId + 1, current).map(id => cache[id]);
    }

    return [];
  };

  const service = async (req: any, res: any) => {
    try {
      debug && console.log('connected', req.url);
      const lastEventId = Number(req.headers['last-event-id']);

      const initialValues = getInitialValues(lastEventId);

      debug && console.log('lastEventId', lastEventId);
      debug && console.log('initialValues', initialValues);

      // const url = req.url;
      // const query = parse(url.split('?')[1]);

      addClient(
        message$,
        {
          initial: initialValues,
        },
        {},
        req,
        res
      );
    } catch (ex) {
      console.log(ex);
      throw ex;
    }
  };

  subClient.subscribe(`${namespc}::events`);

  return {
    service,
    unsubscribe: () => {
      console.log('unsubscribing from redis');
      subClient.unsubscribe(`${namespc}::events`);
    },
  };
};
