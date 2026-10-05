use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use std::thread;

pub struct CacheEntry<V> {
    value: V,
    expires_at: Option<Instant>,
}

impl<V> CacheEntry<V> {
    pub fn new(value: V, ttl: Option<Duration>) -> Self {
        let expires_at = ttl.map(|d| Instant::now() + d);
        CacheEntry { value, expires_at }
    }

    pub fn is_expired(&self) -> bool {
        match self.expires_at {
            Some(expiration) => Instant::now() >= expiration,
            None => false,
        }
    }
}

pub struct ConcurrentCache<K, V> {
    store: Arc<RwLock<HashMap<K, CacheEntry<V>>>>,
}

impl<K, V> ConcurrentCache<K, V>
where
    K: Eq + Hash + Send + Sync + 'static,
    V: Clone + Send + Sync + 'static,
{
    pub fn new() -> Self {
        ConcurrentCache {
            store: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn insert(&self, key: K, value: V, ttl: Option<Duration>) {
        let entry = CacheEntry::new(value, ttl);
        let mut map = self.store.write().unwrap();
        map.insert(key, entry);
    }

    pub fn get(&self, key: &K) -> Option<V> {
        let map = self.store.read().unwrap();
        if let Some(entry) = map.get(key) {
            if !entry.is_expired() {
                return Some(entry.value.clone());
            }
        }
        None
    }

    pub fn remove(&self, key: &K) -> Option<V> {
        let mut map = self.store.write().unwrap();
        map.remove(key).map(|e| e.value)
    }

    pub fn len(&self) -> usize {
        let map = self.store.read().unwrap();
        map.len()
    }

    pub fn start_cleanup_thread(&self, interval: Duration) {
        let store_clone = Arc::clone(&self.store);
        thread::spawn(move || loop {
            thread::sleep(interval);
            let mut map = store_clone.write().unwrap();
            map.retain(|_, entry| !entry.is_expired());
        });
    }
}

impl<K, V> Default for ConcurrentCache<K, V> {
    fn default() -> Self {
        Self::new()
    }
}

fn main() {
    let cache = ConcurrentCache::new();

    cache.insert("user_101", "Alice", Some(Duration::from_secs(2)));
    cache.insert("user_102", "Bob", None);

    println!("Initial len: {}", cache.len());

    if let Some(val) = cache.get(&"user_101") {
        println!("Found user_101: {}", val);
    }

    cache.start_cleanup_thread(Duration::from_millis(500));

    println!("Waiting for TTL expiration...");
    thread::sleep(Duration::from_secs(3));

    println!("User 101 post-expiration: {:?}", cache.get(&"user_101"));
    println!("User 102 post-expiration: {:?}", cache.get(&"user_102"));
    println!("Final len after cleanup: {}", cache.len());
}
