#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// GTK3 коммитит dmabuf без acquire point, и KWin с NVIDIA рвёт соединение по протоколу.
#[cfg(target_os = "linux")]
fn nvidia_wayland_workaround() {
    let nvidia = std::path::Path::new("/sys/module/nvidia_drm").exists();
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
    if nvidia && wayland && std::env::var_os("__NV_DISABLE_EXPLICIT_SYNC").is_none() {
        std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    nvidia_wayland_workaround();
    animejoya_lib::run()
}
