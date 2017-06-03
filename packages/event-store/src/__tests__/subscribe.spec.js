/* @flow */
import micro from 'micro';

import { delay } from 'awaiting';
import listen from 'test-listen';
import request from 'request';

import { createClient } from '../redis-client';
import makeSubscribe from '../subscribe';

const kefir = require('kefir');

jest.unmock('micro');

const fromURL = url => {
  const stream = request(url);

  const data$ = kefir.stream(emitter => {
    const emitString = data => {
      emitter.emit(String(data));
    };

    const errorString = data => {
      emitter.error(String(data));
    };

    const end = () => {
      emitter.end();
    };

    stream.on('data', emitString);
    stream.on('error', errorString);
    stream.on('end', end);

    return () => {
      stream.removeListener('data', emitString);
      stream.removeListener('error', errorString);
      stream.removeListener('end', end);
      stream.end();
    };
  });

  return {
    data$,
    abort: () => stream.abort(),
  };
};

const takeEvents = (count, stream) =>
  stream.take(count).scan((prev, next) => prev.concat(next), []).toPromise();

describe('subscribe endpoint', () => {
  it('should subscribe', async () => {
    const pubClient = createClient();
    const service = makeSubscribe({
      history: { size: 10 },
    });
    const server = micro(service);
    const url = await listen(server);
    const { data$, abort } = fromURL(url);

    // 1 -> :ok
    // 2 -> first event
    // 3 -> second event
    // 4 -> abort
    const promise = takeEvents(4, data$);
    await delay(100);

    pubClient.publish('events', '1:{"type":"first"}');
    pubClient.publish('events', `2:{"type":"second","payload":123}`);
    await delay(100);

    abort();
    server.close();
    const val = await promise;
    pubClient.quit();
    expect(val).toMatchSnapshot();
  });

  it('should work with 2 clients', async () => {
    const pubClient = createClient();
    const service = makeSubscribe({
      redis: {},
      history: { size: 10 },
    });
    const server = micro(service);
    const url = await listen(server);

    const http1 = fromURL(url + '?client=1');
    const http2 = fromURL(url + '?client=2');
    await delay(100);

    const promise1 = takeEvents(4, http1.data$);
    const promise2 = takeEvents(3, http2.data$);

    // publish 2 events
    // client 1 will wait until the end
    // client 2 will abort early after the first event
    pubClient.publish('events', '1:{"type":"first"}');

    await delay(10);
    http2.abort();

    await delay(10);
    pubClient.publish('events', `2:{"type":"second"}`);

    await delay(10);
    http1.abort();

    const val1 = await promise1;
    const val2 = await promise2;

    expect(val1.length).toBe(2);
    expect(val2.length).toBe(1);
  });
});