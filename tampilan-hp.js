/* PERBAIKAN TAMPILAN HP — dimuat otomatis lewat surat-form.js.
   Merapikan header, kartu saldo, menu bawah warga, ringkasan kas warga,
   dan tombol di Data Warga supaya pas di layar HP. Tidak mengubah data. */
(function () {
  if (window.__tampilanHP) return;
  window.__tampilanHP = true;

  const css = `
html{-webkit-text-size-adjust:100%}
body{overflow-x:hidden}

/* Header */
.hdr-top{display:flex!important;justify-content:space-between!important;align-items:center!important;gap:12px!important}
.hdr-brand{display:flex!important;align-items:center!important;gap:12px!important;min-width:0!important;flex:1!important}
.hdr-logo{object-fit:contain!important;border-radius:10px!important}
.hdr-text{min-width:0}
.hdr-title{line-height:1.15;white-space:nowrap}
.hdr-actions{flex-shrink:0}

/* Angka di kartu statistik tidak boleh terpotong di tengah */
.stat b{overflow-wrap:normal!important;word-break:keep-all!important;white-space:nowrap!important}

/* Menu bawah warga: menempel di bawah layar, tidak menutupi isi */
.bottom{position:fixed!important;left:0;right:0;bottom:0;z-index:50;max-width:900px;margin:0 auto!important;background:#fff;border-top:1px solid #dde5ef!important;box-shadow:0 -4px 14px rgba(15,23,42,.06);padding:6px 6px calc(6px + env(safe-area-inset-bottom))!important;display:flex;justify-content:space-around}
.bottom button{flex:1;min-height:52px;border:0;background:transparent;font-size:12px!important;font-weight:600;color:#183452;border-radius:10px;line-height:1.35}
.bottom button:active{background:#eef4fc}
.wrap.ada-menu-bawah{padding-bottom:84px}

/* Ringkasan Kas warga: label kiri, nominal kanan */
#kasRingkasan .row{display:flex;justify-content:space-between;align-items:center;gap:12px}
#kasRingkasan .row span{text-align:right;white-space:nowrap}

/* Tombol di daftar Data Warga lebih mudah ditekan */
#residentList button.btn{padding:8px 10px!important;font-size:12px!important;min-height:36px}
#residentList > div > div:nth-child(2) > div:first-child{overflow-wrap:break-word!important}
#residentList > div > div:nth-child(2) > span{white-space:nowrap}
@media (max-width:400px){
  #residentList > div{gap:9px!important;padding:10px!important}
  #residentList > div > div:first-child > *{width:44px!important;height:44px!important;font-size:20px!important}
}

@media (max-width:600px){
  .hdr{padding:14px!important;border-radius:16px!important;margin-bottom:14px!important}
  .hdr-top{align-items:flex-start!important}
  .hdr-brand{gap:10px!important}
  .hdr-logo{width:56px!important;height:56px!important;border-radius:9px!important}
  .hdr-title{font-size:21px!important}
  .hdr-sub{font-size:12px!important;line-height:1.3}
  .hdr-tag{font-size:12px!important;margin-top:3px!important;line-height:1.3}
  .hdr-bell{width:40px!important;height:40px!important;font-size:19px!important}
  .hdr-logout{padding:9px 11px!important;font-size:13px!important}
  .hdr-foot{margin-top:10px!important;font-size:11.5px!important}
  .stat{padding:14px 12px!important}
  .stat b{font-size:clamp(17px,5.4vw,26px)!important}
}
@media (max-width:360px){
  .hdr-logo{width:46px!important;height:46px!important}
  .hdr-title{font-size:19px!important}
  .hdr-logout{padding:9px 10px!important}
  .menu button{font-size:13px!important}
}
`;

  const style = document.createElement("style");
  style.id = "tampilan-hp";
  style.textContent = css;
  document.head.appendChild(style);

  const LABEL_STATUS = {
    aktif: "Aktif",
    nonaktif: "Nonaktif",
    menunggu_verifikasi: "Menunggu verifikasi"
  };

  function rapikan() {
    const app = document.getElementById("app");
    if (!app) return;

    // Tandai bagian header (hanya header halaman setelah login)
    const wrap = app.querySelector(":scope > .wrap");
    const hdr = wrap && wrap.firstElementChild;
    if (hdr && !hdr.classList.contains("hdr") &&
        hdr.querySelector('img[src="/images.png"]') &&
        hdr.querySelector('button[onclick="logout()"]')) {
      hdr.classList.add("hdr");
      const top = hdr.children[0];
      const foot = hdr.children[1];
      if (top) {
        top.classList.add("hdr-top");
        const brand = top.children[0];
        const actions = top.children[1];
        if (brand) {
          brand.classList.add("hdr-brand");
          const logo = brand.querySelector("img");
          if (logo) logo.classList.add("hdr-logo");
          const text = brand.children[1];
          if (text) {
            text.classList.add("hdr-text");
            if (text.children[0]) text.children[0].classList.add("hdr-title");
            if (text.children[1]) text.children[1].classList.add("hdr-sub");
            if (text.children[2]) text.children[2].classList.add("hdr-tag");
          }
        }
        if (actions) {
          actions.classList.add("hdr-actions");
          const bell = actions.querySelector('button[aria-label="Notifikasi"]');
          if (bell) bell.classList.add("hdr-bell");
          const out = actions.querySelector('button[onclick="logout()"]');
          if (out) out.classList.add("hdr-logout");
        }
      }
      if (foot) foot.classList.add("hdr-foot");
    }

    // Beri ruang di bawah halaman bila ada menu bawah
    if (wrap) wrap.classList.toggle("ada-menu-bawah", !!wrap.querySelector(".bottom"));

    // Status warga lebih mudah dibaca (tanpa garis bawah)
    const list = document.getElementById("residentList");
    if (list) {
      list.querySelectorAll("span").forEach(el => {
        if (el.children.length) return;
        const key = el.textContent.trim().toLowerCase();
        if (LABEL_STATUS[key] && el.textContent !== LABEL_STATUS[key]) el.textContent = LABEL_STATUS[key];
      });
    }
  }

  function mulai() {
    const app = document.getElementById("app");
    if (!app) return;
    let antre = false;
    new MutationObserver(() => {
      if (antre) return;
      antre = true;
      requestAnimationFrame(() => { antre = false; rapikan(); });
    }).observe(app, { childList: true, subtree: true });
    rapikan();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mulai);
  } else {
    mulai();
  }
})();
