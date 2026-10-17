// 家電管理のオフライン対応。このアプリのファイルだけを扱い、他のアプリには触れない
// ネットワーク優先のため、ファイルを更新しても通常は番号の更新は不要（古いキャッシュを捨てたいときだけ上げる）。
var CACHE='kaden-app-v4';
var FILES=['kaden-manager.html','cloud-sync.js','kaden-manifest.json','kaden-icon-192.png','kaden-icon-512.png'];
var WAIT_MS=3000; // 電波が弱くて応答が遅いとき、この時間を過ぎたら保存済みの版を先に出す

self.addEventListener('install',function(e){
  // 1つのファイルが取れなくても、インストール全体は失敗させない。HTTPキャッシュを使わず最新を取る
  e.waitUntil(caches.open(CACHE).then(function(c){
    return Promise.all(FILES.map(function(u){return c.add(new Request(u,{cache:'reload'})).catch(function(){});}));
  }).then(function(){return self.skipWaiting();}));
});

self.addEventListener('activate',function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){return k!==CACHE&&k.indexOf('kaden-app-')===0;}).map(function(k){return caches.delete(k);}));
    }).then(function(){return self.clients.claim();})
  );
});

// ネットワーク優先。つながらない・遅いときは保存済みの版を出す
self.addEventListener('fetch',function(e){
  var url=new URL(e.request.url);
  if(e.request.method!=='GET'||url.origin!==location.origin)return;
  var name=url.pathname.split('/').pop();
  if(FILES.indexOf(name)<0){
    // 他のアプリのファイル：通常どおり取得し、つながらないときだけ、端末に保存済みの版を出す（同じ範囲の別アプリのSWが入れ替わっていても、オフラインで開けるように）
    e.respondWith(fetch(e.request).catch(function(){return caches.match(e.request,{ignoreSearch:true}).then(function(r){return r||Response.error();});}));
    return;
  }
  var cached=function(){return caches.match(e.request,{ignoreSearch:true});};
  // HTTPキャッシュを使わず毎回確認する。正常応答だけを保存し、404/500では保存済みの版を守る
  var net=fetch(e.request,{cache:'no-cache'}).then(function(res){
    if(res.ok){
      var copy=res.clone();
      e.waitUntil(caches.open(CACHE).then(function(c){return c.put(e.request,copy);}));
    }
    return res;
  });
  // 応答が遅いときだけ、保存済みの版を先に出す（保存済みがなければ待ち続ける）。ネットワークの結果は裏で保存する
  var slow=new Promise(function(resolve){
    setTimeout(function(){cached().then(function(r){if(r)resolve(r);});},WAIT_MS);
  });
  e.waitUntil(net.catch(function(){}));
  e.respondWith(Promise.race([
    net.catch(function(){return cached().then(function(r){return r||Response.error();});}),
    slow
  ]));
});
