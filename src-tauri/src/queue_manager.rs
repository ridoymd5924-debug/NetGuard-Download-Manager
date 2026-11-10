use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;
use chrono::{Datelike, Timelike};

use crate::types::{DownloadQueue, QueueSchedule};

pub type EventCallback = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync + 'static>;

pub struct QueueManager {
    queues: Arc<Mutex<HashMap<String, DownloadQueue>>>,
    emit: EventCallback,
    db_path: PathBuf,
    shutdown_tx: Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
}

impl QueueManager {
    pub fn new(db_path: &Path, emit: EventCallback) -> Self {
        let manager = Self {
            queues: Arc::new(Mutex::new(HashMap::new())),
            emit,
            db_path: db_path.to_path_buf(),
            shutdown_tx: Arc::new(Mutex::new(None)),
        };
        manager.load_queues_sync();

        // Create default queue if none exist
        let queues_clone = Arc::clone(&manager.queues);
        let db_path_clone = manager.db_path.clone();
        tauri::async_runtime::spawn(async move {
            let mut queues = queues_clone.lock().await;
            if queues.is_empty() {
                let default = DownloadQueue {
                    id: generate_id(),
                    name: "Default Queue".to_string(),
                    download_ids: Vec::new(),
                    max_concurrent: 3,
                    enabled: true,
                    schedule: None,
                };
                queues.insert(default.id.clone(), default);
                save_queues_to_disk(&queues, &db_path_clone);
            }
        });

        manager
    }

    fn load_queues_sync(&self) {
        let file = self.db_path.join("queues.json");
        if let Ok(content) = std::fs::read_to_string(&file) {
            if let Ok(items) = serde_json::from_str::<Vec<DownloadQueue>>(&content) {
                if let Ok(mut queues) = self.queues.try_lock() {
                    for q in items {
                        queues.insert(q.id.clone(), q);
                    }
                }
            }
        }
    }

    async fn save_queues(&self) {
        let queues = self.queues.lock().await;
        save_queues_to_disk(&queues, &self.db_path);
    }

    pub fn start_scheduler(&self) {
        let queues = Arc::clone(&self.queues);
        let emit = Arc::clone(&self.emit);
        let shutdown_arc = Arc::clone(&self.shutdown_tx);

        tauri::async_runtime::spawn(async move {
            let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
            {
                let mut lock = shutdown_arc.lock().await;
                *lock = Some(shutdown_tx);
            }

            // Last observed "inside the window?" state per queue, used to detect the moment a
            // window opens/closes. The scheduler used to emit a passive "check" event that nothing
            // listened to, so scheduled queues never actually started or stopped anything.
            let mut last_active: HashMap<String, bool> = HashMap::new();

            loop {
                let snapshot: Vec<DownloadQueue> = queues.lock().await.values().cloned().collect();
                for queue in snapshot {
                    let schedule = match (&queue.schedule, queue.enabled) {
                        (Some(s), true) if s.enabled => s.clone(),
                        _ => {
                            last_active.remove(&queue.id);
                            continue;
                        }
                    };
                    let active = is_within_schedule(&schedule);
                    let prev = last_active.insert(queue.id.clone(), active);
                    let payload = serde_json::json!({
                        "queueId": queue.id,
                        "queueName": queue.name,
                        "downloadIds": queue.download_ids,
                        "active": active,
                    });
                    match schedule_transition(prev, active) {
                        Some(true) => emit("queue:schedule-start", payload.clone()),
                        Some(false) => emit("queue:schedule-stop", payload.clone()),
                        None => {}
                    }
                    emit("queue:schedule-check", payload);
                }

                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => {}
                }
            }
        });
    }

    pub fn stop_scheduler(&self) {
        let shutdown_arc = Arc::clone(&self.shutdown_tx);
        tauri::async_runtime::spawn(async move {
            let mut lock = shutdown_arc.lock().await;
            if let Some(tx) = lock.take() {
                tx.send(()).ok();
            }
        });
    }

    pub async fn get_queues(&self) -> Vec<DownloadQueue> {
        self.queues.lock().await.values().cloned().collect()
    }

    pub async fn create_queue(&self, name: String, max_concurrent: u32) -> DownloadQueue {
        let queue = DownloadQueue {
            id: generate_id(),
            name,
            download_ids: Vec::new(),
            max_concurrent,
            enabled: true,
            schedule: None,
        };
        let id = queue.id.clone();
        {
            let mut queues = self.queues.lock().await;
            queues.insert(id, queue.clone());
        }
        self.save_queues().await;
        (self.emit)("queue:created", serde_json::to_value(&queue).unwrap_or_default());
        queue
    }

    pub async fn update_queue(
        &self,
        id: &str,
        updates: serde_json::Value,
    ) -> Option<DownloadQueue> {
        let mut queues = self.queues.lock().await;
        if let Some(queue) = queues.get_mut(id) {
            if let Some(name) = updates.get("name").and_then(|v| v.as_str()) {
                queue.name = name.to_string();
            }
            if let Some(mc) = updates.get("maxConcurrent").and_then(|v| v.as_u64()) {
                queue.max_concurrent = mc as u32;
            }
            if let Some(enabled) = updates.get("enabled").and_then(|v| v.as_bool()) {
                queue.enabled = enabled;
            }
            let q = queue.clone();
            drop(queues);
            self.save_queues().await;
            (self.emit)("queue:updated", serde_json::to_value(&q).unwrap_or_default());
            Some(q)
        } else {
            None
        }
    }

    pub async fn delete_queue(&self, id: &str) -> bool {
        let len = self.queues.lock().await.len();
        if len <= 1 {
            return false; // Can't delete last queue
        }
        let deleted = {
            let mut queues = self.queues.lock().await;
            queues.remove(id).is_some()
        };
        if deleted {
            self.save_queues().await;
            (self.emit)("queue:deleted", serde_json::json!({ "id": id }));
        }
        deleted
    }

    pub async fn add_to_queue(&self, queue_id: &str, download_ids: Vec<String>) -> bool {
        let mut queues = self.queues.lock().await;
        if !queues.contains_key(queue_id) {
            return false;
        }

        // Remove from other queues first
        let id_set: std::collections::HashSet<&String> = download_ids.iter().collect();
        for (qid, q) in queues.iter_mut() {
            if qid != queue_id {
                q.download_ids.retain(|id| !id_set.contains(id));
            }
        }

        // Add to target queue
        if let Some(q) = queues.get_mut(queue_id) {
            for id in &download_ids {
                if !q.download_ids.contains(id) {
                    q.download_ids.push(id.clone());
                }
            }
            let q = q.clone();
            drop(queues);
            self.save_queues().await;
            (self.emit)("queue:updated", serde_json::to_value(&q).unwrap_or_default());
            true
        } else {
            false
        }
    }

    pub async fn set_schedule(&self, queue_id: &str, schedule: Option<QueueSchedule>) -> bool {
        let mut queues = self.queues.lock().await;
        if let Some(q) = queues.get_mut(queue_id) {
            q.schedule = schedule;
            let q = q.clone();
            drop(queues);
            self.save_queues().await;
            (self.emit)("queue:updated", serde_json::to_value(&q).unwrap_or_default());
            true
        } else {
            false
        }
    }
}

fn save_queues_to_disk(queues: &HashMap<String, DownloadQueue>, db_path: &Path) {
    let items: Vec<&DownloadQueue> = queues.values().collect();
    if let Ok(json) = serde_json::to_string_pretty(&items) {
        let file = db_path.join("queues.json");
        std::fs::write(&file, json).ok();
    }
}

fn generate_id() -> String {
    Uuid::new_v4().to_string().replace('-', "")[..16].to_string()
}

fn is_within_schedule(schedule: &QueueSchedule) -> bool {
    let now = chrono::Local::now();
    within_window(
        schedule,
        now.weekday().num_days_from_sunday() as u8,
        now.hour() * 60 + now.minute(),
    )
}

/// Pure window test (day 0=Sunday, minutes since midnight) so it can be unit-tested.
fn within_window(schedule: &QueueSchedule, current_day: u8, current_minutes: u32) -> bool {
    if !schedule.days.contains(&current_day) {
        return false;
    }

    let parse_time = |s: &str| -> u32 {
        let parts: Vec<u32> = s.split(':').filter_map(|p| p.parse().ok()).collect();
        if parts.len() >= 2 {
            parts[0] * 60 + parts[1]
        } else {
            0
        }
    };

    let start_min = parse_time(&schedule.start_time);
    let end_min = parse_time(&schedule.end_time);

    if start_min <= end_min {
        current_minutes >= start_min && current_minutes <= end_min
    } else {
        // Wraps midnight
        current_minutes >= start_min || current_minutes <= end_min
    }
}

/// `Some(true)` = the window just opened (start the queue), `Some(false)` = it just closed
/// (stop it), `None` = no change. A queue first seen inside its window starts immediately;
/// one first seen outside it is left alone.
fn schedule_transition(prev: Option<bool>, now_active: bool) -> Option<bool> {
    match (prev, now_active) {
        (None, true) | (Some(false), true) => Some(true),
        (Some(true), false) => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sched(start: &str, end: &str, days: &[u8]) -> QueueSchedule {
        QueueSchedule {
            enabled: true,
            start_time: start.to_string(),
            end_time: end.to_string(),
            days: days.to_vec(),
        }
    }

    #[test]
    fn same_day_window() {
        let s = sched("09:00", "17:00", &[1, 2, 3, 4, 5]);
        assert!(within_window(&s, 1, 9 * 60));
        assert!(within_window(&s, 3, 12 * 60));
        assert!(!within_window(&s, 3, 8 * 60 + 59));
        assert!(!within_window(&s, 3, 17 * 60 + 1));
        assert!(!within_window(&s, 0, 12 * 60), "Sunday is not selected");
    }

    #[test]
    fn window_wrapping_midnight() {
        let s = sched("23:00", "06:00", &[0, 1, 2, 3, 4, 5, 6]);
        assert!(within_window(&s, 2, 23 * 60 + 30));
        assert!(within_window(&s, 2, 2 * 60));
        assert!(!within_window(&s, 2, 12 * 60));
    }

    #[test]
    fn transitions() {
        assert_eq!(schedule_transition(None, true), Some(true));
        assert_eq!(schedule_transition(None, false), None);
        assert_eq!(schedule_transition(Some(false), true), Some(true));
        assert_eq!(schedule_transition(Some(true), true), None);
        assert_eq!(schedule_transition(Some(true), false), Some(false));
        assert_eq!(schedule_transition(Some(false), false), None);
    }
}
