// 衣服管理のオフライン対応。このアプリのファイルだけを扱い、他のアプリには触れない
// ネットワーク優先のため、ファイルを更新しても通常は番号の更新は不要（古いキャッシュを捨てたいときだけ上げる）。
var CACHE='clothes-manager-v1';
var FILES=['clothes-manager.html','cloud-sync.js','clothes-manifest.json','clothes-icon-192.png','clothes-icon-512.png'];

self.addEventListener('install',function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){return c.addAll(FILES);}).then(function(){return self.skipWaiting();}));
});

self.addEventListener('activate',function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){return k!==CACHE&&k.indexOf('clothes-manager-')===0;}).map(function(k){return caches.delete(k);}));
    }).then(function(){return self.clients.claim();})
  );
});

// ネットワーク優先。つながらないときは保存済みの版を出す
self.addEventListener('fetch',function(e){
  var url=new URL(e.request.url);
  if(e.request.method!=='GET'||url.origin!==location.origin)return;
  var name=url.pathname.split('/').pop();
  if(FILES.indexOf(name)<0)return;
  e.respondWith(
    // HTTPキャッシュを使わず毎回確認する。正常応答だけを保存し、404/500では保存済みの版を守る
    fetch(e.request,{cache:'no-cache'}).then(function(res){
      if(res.ok){
        var copy=res.clone();
        e.waitUntil(caches.open(CACHE).then(function(c){return c.put(e.request,copy);}));
      }
      return res;
    }).catch(function(){return caches.match(e.request,{ignoreSearch:true});})
  );
});
