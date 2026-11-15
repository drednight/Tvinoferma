//! Process-local exclusion and generation cancellation for native macro channels.
//! No unbounded input backlog: conflicting operations are refused, not queued.
use std::cell::Cell;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};

pub struct Arbiter {
    epoch: AtomicU64,
    owner: Mutex<Option<(&'static str, u64)>>,
    dispatch: Mutex<()>,
}
pub static INPUT: Arbiter = Arbiter::new();
thread_local! { static CURRENT: Cell<Option<u64>> = const { Cell::new(None) }; }
impl Arbiter {
    pub const fn new() -> Self {
        Self {
            epoch: AtomicU64::new(0),
            owner: Mutex::new(None),
            dispatch: Mutex::new(()),
        }
    }
    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }
    pub fn acquire(&self, kind: &'static str, epoch: u64) -> Result<Lease<'_>, String> {
        let mut owner = self.owner.lock().map_err(|_| "Input arbiter unavailable")?;
        if epoch != self.epoch() {
            return Err("Input operation cancelled".into());
        }
        if owner.is_some() {
            return Err("Native input busy; retry explicitly after cleanup".into());
        }
        *owner = Some((kind, epoch));
        Ok(Lease {
            arbiter: self,
            epoch,
        })
    }
    pub fn stop(&self) -> Result<(), String> {
        // Short serialization point only; never holds owner or waits for a whole operation.
        let _dispatch = self
            .dispatch
            .lock()
            .map_err(|_| "Input dispatch unavailable")?;
        self.epoch.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    fn dispatch<T>(
        &self,
        epoch: Option<u64>,
        cleanup: bool,
        send: impl FnOnce() -> T,
    ) -> Result<T, String> {
        let _dispatch = self
            .dispatch
            .lock()
            .map_err(|_| "Input dispatch unavailable")?;
        if !cleanup && epoch != Some(self.epoch()) {
            return Err("Input operation cancelled".into());
        }
        Ok(send())
    }
}
pub struct Lease<'a> {
    arbiter: &'a Arbiter,
    epoch: u64,
}
impl Lease<'_> {
    pub fn bind(&self) -> Binding {
        let previous = CURRENT.with(|current| current.replace(Some(self.epoch)));
        Binding(previous)
    }
    #[cfg(test)]
    pub fn cancelled(&self) -> bool {
        self.epoch != self.arbiter.epoch()
    }
}
impl Drop for Lease<'_> {
    fn drop(&mut self) {
        if let Ok(mut owner) = self.arbiter.owner.lock() {
            *owner = None;
        }
    }
}
pub struct Binding(Option<u64>);
impl Drop for Binding {
    fn drop(&mut self) {
        CURRENT.with(|current| current.set(self.0));
    }
}
pub fn cancelled() -> bool {
    CURRENT.with(|current| current.get() != Some(INPUT.epoch()))
}
pub fn dispatch<T>(cleanup: bool, send: impl FnOnce() -> T) -> Result<T, String> {
    INPUT.dispatch(CURRENT.with(Cell::get), cleanup, send)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn excludes_channels_until_cleanup_even_after_stop() {
        let a = Arbiter::new();
        let epoch = a.epoch();
        let lease = a.acquire("command", epoch).unwrap();
        assert!(a.acquire("mirror", epoch).is_err());
        a.stop().unwrap();
        assert!(lease.cancelled());
        assert!(a.acquire("lab", a.epoch()).is_err());
        drop(lease);
        assert!(a.acquire("lab", epoch).is_err());
        assert!(a.acquire("lab", a.epoch()).is_ok());
    }
    #[test]
    fn cancelled_down_is_refused_but_release_is_allowed() {
        let a = Arbiter::new();
        let epoch = a.epoch();
        let _lease = a.acquire("command", epoch).unwrap();
        a.stop().unwrap();
        assert!(a
            .dispatch(Some(epoch), false, || panic!("late down"))
            .is_err());
        assert_eq!(a.dispatch(Some(epoch), true, || 1).unwrap(), 1);
    }
    #[test]
    fn stop_and_dispatch_have_one_ordering_point() {
        use std::sync::Arc;
        let a = Arc::new(Arbiter::new());
        let epoch = a.epoch();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (leave_tx, leave_rx) = std::sync::mpsc::channel();
        let b = a.clone();
        let worker = std::thread::spawn(move || {
            b.dispatch(Some(epoch), false, || {
                entered_tx.send(()).unwrap();
                leave_rx.recv().unwrap();
            })
        });
        entered_rx.recv().unwrap();
        let b = a.clone();
        let stop = std::thread::spawn(move || b.stop());
        leave_tx.send(()).unwrap();
        worker.join().unwrap().unwrap();
        stop.join().unwrap().unwrap();
        assert!(a
            .dispatch(Some(epoch), false, || panic!("stale down"))
            .is_err());
    }
}
