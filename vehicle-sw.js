// 車両管理のオフライン対応。このアプリのファイルだけを扱い、他のアプリには触れない
var CACHE='vehicle-manager-v1';
var FILES=['vehicle_manager.html','cloud-sync.js','vehicle-manifest.json','vehicle-icon-192.png','vehicle-icon-512.png'];

self.addEventListener('install',function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){return c.addAll(FILES);}).then(function(){return self.skipWaiting();}));
});

self.addEventListener('activate',function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){return k!==CACHE&&k.indexOf('vehicle-manager-')===0;}).map(function(k){return caches.delete(k);}));
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
    fetch(e.request).then(function(res){
      var copy=res.clone();
      caches.open(CACHE).then(function(c){c.put(e.request,copy);});
      return res;
    }).catch(function(){return caches.match(e.request);})
  );
});
