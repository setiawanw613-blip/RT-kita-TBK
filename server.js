const express=require("express");
const session=require("express-session");
const bcrypt=require("bcryptjs");
const Database=require("better-sqlite3");
const path=require("path");

const app=express();
const DATA_DIR=process.env.DATA_DIR || ".";
const fs=require("fs");
fs.mkdirSync(DATA_DIR,{recursive:true});
const db=new Database(path.join(DATA_DIR,"rt_kita.db"));
db.pragma("journal_mode = WAL");
app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.set("trust proxy", 1);
app.use(session({
  secret:process.env.SESSION_SECRET || "ganti-rahasia-rt-ini",
  resave:false, saveUninitialized:false,
  cookie:{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:1000*60*60*8}
}));

db.exec(`
CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 username TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('admin','warga')),
 resident_id INTEGER,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS residents(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 nik TEXT UNIQUE,
 no_kk TEXT,
 nama TEXT NOT NULL,
 alamat TEXT,
 no_hp TEXT,
 status TEXT DEFAULT 'Aktif',
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS announcements(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 title TEXT NOT NULL,
 content TEXT NOT NULL,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS complaints(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 resident_id INTEGER,
 title TEXT NOT NULL,
 content TEXT NOT NULL,
 status TEXT DEFAULT 'Baru',
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS letters(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 resident_id INTEGER,
 type TEXT NOT NULL,
 purpose TEXT,
 status TEXT DEFAULT 'Diajukan',
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS cash(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 type TEXT NOT NULL,
 description TEXT NOT NULL,
 amount INTEGER NOT NULL,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

function seed(){
 const count=db.prepare("SELECT COUNT(*) c FROM users").get().c;
 if(count===0){
   const hash=bcrypt.hashSync("admin123",10);
   db.prepare("INSERT INTO users(username,password_hash,role) VALUES(?,?,?)").run("admin",hash,"admin");
 }
 const rc=db.prepare("SELECT COUNT(*) c FROM residents").get().c;
 if(rc===0){
   const ins=db.prepare("INSERT INTO residents(nik,no_kk,nama,alamat,no_hp) VALUES(?,?,?,?,?)");
   ins.run("3200000000000001","3200000000000001","Budi Setiawan","RT 01 / RW 05","081234567890");
   ins.run("3200000000000002","3200000000000002","Siti Aminah","RT 01 / RW 05","081234567891");
   ins.run("3200000000000003","3200000000000003","Andi Saputra","RT 01 / RW 05","081234567892");
 }
 const ac=db.prepare("SELECT COUNT(*) c FROM announcements").get().c;
 if(ac===0) db.prepare("INSERT INTO announcements(title,content) VALUES(?,?)").run("Kerja Bakti Lingkungan","Kerja bakti Minggu pukul 07.00 WIB. Mohon warga membawa alat kebersihan.");
}
seed();

function auth(req,res,next){ if(!req.session.user) return res.status(401).json({error:"Belum login"}); next(); }
function admin(req,res,next){ if(!req.session.user || req.session.user.role!=="admin") return res.status(403).json({error:"Khusus Ketua RT"}); next(); }

app.post("/api/login",(req,res)=>{
 const {username,password}=req.body;
 const u=db.prepare("SELECT * FROM users WHERE username=?").get(username);
 if(!u || !bcrypt.compareSync(password,u.password_hash)) return res.status(401).json({error:"Username atau password salah"});
 req.session.user={id:u.id,username:u.username,role:u.role,resident_id:u.resident_id};
 res.json({user:req.session.user});
});
app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get("/api/me",(req,res)=>res.json({user:req.session.user||null}));

app.get("/api/dashboard",auth,(req,res)=>{
 const residents=db.prepare("SELECT COUNT(*) c FROM residents WHERE status='Aktif'").get().c;
 const letters=db.prepare("SELECT COUNT(*) c FROM letters WHERE status='Diajukan'").get().c;
 const complaints=db.prepare("SELECT COUNT(*) c FROM complaints WHERE status='Baru'").get().c;
 const kasIn=db.prepare("SELECT COALESCE(SUM(amount),0) s FROM cash WHERE type='Masuk'").get().s;
 const kasOut=db.prepare("SELECT COALESCE(SUM(amount),0) s FROM cash WHERE type='Keluar'").get().s;
 res.json({residents,letters,complaints,balance:kasIn-kasOut});
});

app.get("/api/residents",admin,(req,res)=>res.json(db.prepare("SELECT * FROM residents ORDER BY nama").all()));
app.post("/api/residents",admin,(req,res)=>{
 const {nik,no_kk,nama,alamat,no_hp,status="Aktif"}=req.body;
 if(!nama) return res.status(400).json({error:"Nama wajib diisi"});
 const r=db.prepare("INSERT INTO residents(nik,no_kk,nama,alamat,no_hp,status) VALUES(?,?,?,?,?,?)").run(nik||null,no_kk||null,nama,alamat||"",no_hp||"",status);
 res.json({id:r.lastInsertRowid});
});
app.put("/api/residents/:id",admin,(req,res)=>{
 const {nik,no_kk,nama,alamat,no_hp,status}=req.body;
 db.prepare("UPDATE residents SET nik=?,no_kk=?,nama=?,alamat=?,no_hp=?,status=? WHERE id=?").run(nik,no_kk,nama,alamat,no_hp,status,req.params.id);
 res.json({ok:true});
});

app.get("/api/my-data",auth,(req,res)=>{
 if(req.session.user.role!=="warga") return res.status(403).json({error:"Bukan akun warga"});
 res.json(db.prepare("SELECT * FROM residents WHERE id=?").get(req.session.user.resident_id));
});
app.get("/api/announcements",auth,(req,res)=>res.json(db.prepare("SELECT * FROM announcements ORDER BY id DESC").all()));
app.post("/api/announcements",admin,(req,res)=>{
 const {title,content}=req.body;
 db.prepare("INSERT INTO announcements(title,content) VALUES(?,?)").run(title,content);
 res.json({ok:true});
});
app.get("/api/complaints",auth,(req,res)=>{
 if(req.session.user.role==="admin") return res.json(db.prepare("SELECT c.*,r.nama FROM complaints c LEFT JOIN residents r ON r.id=c.resident_id ORDER BY c.id DESC").all());
 res.json(db.prepare("SELECT * FROM complaints WHERE resident_id=? ORDER BY id DESC").all(req.session.user.resident_id));
});
app.post("/api/complaints",auth,(req,res)=>{
 if(req.session.user.role!=="warga") return res.status(403).json({error:"Hanya warga"});
 const {title,content}=req.body;
 db.prepare("INSERT INTO complaints(resident_id,title,content) VALUES(?,?,?)").run(req.session.user.resident_id,title,content);
 res.json({ok:true});
});
app.patch("/api/complaints/:id",admin,(req,res)=>{
 db.prepare("UPDATE complaints SET status=? WHERE id=?").run(req.body.status,req.params.id); res.json({ok:true});
});
app.get("/api/letters",auth,(req,res)=>{
 if(req.session.user.role==="admin") return res.json(db.prepare("SELECT l.*,r.nama FROM letters l LEFT JOIN residents r ON r.id=l.resident_id ORDER BY l.id DESC").all());
 res.json(db.prepare("SELECT * FROM letters WHERE resident_id=? ORDER BY id DESC").all(req.session.user.resident_id));
});
app.post("/api/letters",auth,(req,res)=>{
 if(req.session.user.role!=="warga") return res.status(403).json({error:"Hanya warga"});
 const {type,purpose}=req.body;
 db.prepare("INSERT INTO letters(resident_id,type,purpose) VALUES(?,?,?)").run(req.session.user.resident_id,type,purpose||"");
 res.json({ok:true});
});
app.patch("/api/letters/:id",admin,(req,res)=>{
 db.prepare("UPDATE letters SET status=? WHERE id=?").run(req.body.status,req.params.id); res.json({ok:true});
});
app.get("/api/cash",auth,(req,res)=>res.json(db.prepare("SELECT * FROM cash ORDER BY id DESC").all()));
app.post("/api/cash",admin,(req,res)=>{
 const {type,description,amount}=req.body;
 db.prepare("INSERT INTO cash(type,description,amount) VALUES(?,?,?)").run(type,description,Number(amount));
 res.json({ok:true});
});

app.use(express.static(path.join(__dirname,"public")));
app.get("/health",(req,res)=>res.json({ok:true,app:"RT Kita"}));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`RT Kita berjalan di http://localhost:${PORT}`));
