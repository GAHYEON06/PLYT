#include "vendor/httplib.h"
#include "vendor/json.hpp"
#include "vendor/sqlite3.h"
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <regex>
#ifdef _WIN32
#include <bcrypt.h>
#else
#include <openssl/evp.h>
#include <openssl/rand.h>
#endif
using J = nlohmann::json;
namespace fs = std::filesystem;
sqlite3 *db = nullptr;
std::recursive_mutex mx;
long long now() {
  return std::chrono::duration_cast<std::chrono::seconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}
std::string hex(const unsigned char *p, int n) {
  const char *h = "0123456789abcdef";
  std::string s;
  for (int i = 0; i < n; i++) {
    s += h[p[i] >> 4];
    s += h[p[i] & 15];
  }
  return s;
}
std::string randomKey() {
  unsigned char b[32];
#ifdef _WIN32
  if (BCryptGenRandom(nullptr, b, 32, BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0)
    throw std::runtime_error("Random source failed");
#else
  if (RAND_bytes(b, 32) != 1)
    throw std::runtime_error("Random source failed");
#endif
  return hex(b, 32);
}
std::string hashPassword(std::string p, std::string salt) {
  unsigned char out[32];
#ifdef _WIN32
  BCRYPT_ALG_HANDLE alg = nullptr;
  if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr,
                                  BCRYPT_ALG_HANDLE_HMAC_FLAG) != 0)
    throw std::runtime_error("Crypto failed");
  auto rc = BCryptDeriveKeyPBKDF2(alg, (PUCHAR)p.data(), (ULONG)p.size(),
                                  (PUCHAR)salt.data(), (ULONG)salt.size(),
                                  210000, out, 32, 0);
  BCryptCloseAlgorithmProvider(alg, 0);
  if (rc != 0)
    throw std::runtime_error("Crypto failed");
#else
  if (PKCS5_PBKDF2_HMAC(p.data(), (int)p.size(),
                        (const unsigned char *)salt.data(), (int)salt.size(),
                        210000, EVP_sha256(), 32, out) != 1)
    throw std::runtime_error("Crypto failed");
#endif
  return hex(out, 32);
}
bool same(const std::string &a, const std::string &b) {
  unsigned int d = (unsigned int)(a.size() ^ b.size());
  for (size_t i = 0; i < a.size() && i < b.size(); i++)
    d |= a[i] ^ b[i];
  return d == 0;
}
J sql(std::string query, J params = J::array()) {
  if (!params.is_array())
    params = J::array({params});
  sqlite3_stmt *st = nullptr;
  if (sqlite3_prepare_v2(db, query.c_str(), -1, &st, nullptr) != SQLITE_OK)
    throw std::runtime_error(sqlite3_errmsg(db));
  for (size_t i = 0; i < params.size(); i++) {
    auto &v = params[i];
    if (v.is_number_integer())
      sqlite3_bind_int64(st, (int)i + 1, v.get<long long>());
    else if (v.is_null())
      sqlite3_bind_null(st, (int)i + 1);
    else {
      auto s = v.get<std::string>();
      sqlite3_bind_text(st, (int)i + 1, s.c_str(), -1, SQLITE_TRANSIENT);
    }
  }
  J rows = J::array();
  int rc;
  while ((rc = sqlite3_step(st)) == SQLITE_ROW) {
    J r;
    for (int i = 0; i < sqlite3_column_count(st); i++) {
      auto name = sqlite3_column_name(st, i);
      if (sqlite3_column_type(st, i) == SQLITE_INTEGER)
        r[name] = sqlite3_column_int64(st, i);
      else if (sqlite3_column_type(st, i) == SQLITE_NULL)
        r[name] = nullptr;
      else
        r[name] = (const char *)sqlite3_column_text(st, i);
    }
    rows.push_back(r);
  }
  sqlite3_finalize(st);
  if (rc != SQLITE_DONE)
    throw std::runtime_error(sqlite3_errmsg(db));
  return rows;
}
struct Error {
  int status;
  std::string message;
};
void require(bool b, int s, std::string m) {
  if (!b)
    throw Error{s, m};
}
std::string field(J j, std::string k, size_t max = 150) {
  require(j.contains(k) && j[k].is_string(), 400,
          "필수 항목을 확인해주세요: " + k);
  auto s = j[k].get<std::string>();
  require(!s.empty() && s.size() <= max, 400, "입력 길이를 확인해주세요: " + k);
  return s;
}
std::string lower(std::string s) {
  for (auto &c : s)
    c = (char)std::tolower((unsigned char)c);
  return s;
}
J user(const httplib::Request &r) {
  auto h = r.get_header_value("Authorization");
  require(h.rfind("Bearer ", 0) == 0, 401, "로그인이 필요해요.");
  auto rows = sql("SELECT u.id,u.email,u.name,u.role FROM sessions s JOIN "
                  "users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?",
                  {h.substr(7), now()});
  require(!rows.empty(), 401, "로그인이 만료됐어요.");
  return rows[0];
}
void dateTime(std::string d, std::string t, int duration) {
  require(std::regex_match(d, std::regex("[0-9]{4}-[0-9]{2}-[0-9]{2}")) &&
              std::regex_match(t, std::regex("(0[0-9]|1[0-9]|2[0-3]):(00|30)")),
          400, "날짜와 30분 단위 시간을 확인해주세요.");
  std::tm tm{};
  tm.tm_year = std::stoi(d.substr(0, 4)) - 1900;
  tm.tm_mon = std::stoi(d.substr(5, 2)) - 1;
  tm.tm_mday = std::stoi(d.substr(8, 2));
  tm.tm_hour = std::stoi(t.substr(0, 2));
  tm.tm_min = std::stoi(t.substr(3, 2));
  tm.tm_isdst = -1;
  auto original = tm;
  auto epoch = std::mktime(&tm);
  require(epoch > now() && tm.tm_year == original.tm_year &&
              tm.tm_mon == original.tm_mon && tm.tm_mday == original.tm_mday,
          400, "미래의 유효한 날짜를 선택해주세요.");
  int minute = tm.tm_hour * 60 + tm.tm_min;
  require(duration >= 60 && duration <= 240 && duration % 30 == 0 &&
              minute >= 540 && minute + duration <= 1320,
          400, "운영시간은 09:00–22:00, 이용시간은 1–4시간이에요.");
}
void event(std::string id, J u, std::string action) {
  sql("INSERT INTO events(request_id,actor_id,action,created_at) "
      "VALUES(?,?,?,?)",
      {id, u["id"], action, now()});
}
J requests(J u) {
  J result = J::array();
  auto rows = u["role"] == "owner"
                  ? sql("SELECT body FROM requests ORDER BY created_at DESC")
                  : sql("SELECT body FROM requests WHERE requester_id=? OR "
                        "recipient_id=? ORDER BY created_at DESC",
                        {u["id"], u["id"]});
  for (auto &r : rows) {
    auto v = J::parse(r["body"].get<std::string>());
    result.push_back(v);
  }
  return result;
}
bool overlap(std::string a, int ad, std::string b, int bd) {
  auto m = [](std::string t) {
    return std::stoi(t.substr(0, 2)) * 60 + std::stoi(t.substr(3, 2));
  };
  return m(a) < m(b) + bd && m(b) < m(a) + ad;
}
#ifdef _WIN32
int wmain(int argc, wchar_t **argv) {
  try {
#else
int main(int argc, char **argv) {
  try {
#endif
    fs::path root = argc > 1 ? fs::path(argv[1]) : fs::current_path();
    fs::create_directories(root / "data");
    auto dbpath = (root / "data/plyt.sqlite").u8string();
    if (sqlite3_open(dbpath.c_str(), &db) != SQLITE_OK)
      throw std::runtime_error("Database open failed");
    sqlite3_busy_timeout(db, 5000);
    sql("PRAGMA journal_mode=WAL");
    sql("PRAGMA foreign_keys=ON");
    sql("CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT "
        "UNIQUE NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL,salt TEXT NOT "
        "NULL,password TEXT NOT NULL)");
    sql("CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id "
        "TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL)");
    sql("CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,requester_id "
        "TEXT NOT NULL,recipient_id TEXT,body TEXT NOT NULL,created_at INTEGER "
        "NOT NULL)");
    sql("CREATE TABLE IF NOT EXISTS favorites(user_id TEXT NOT NULL,space_id "
        "INTEGER NOT NULL,PRIMARY KEY(user_id,space_id))");
    sql("CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,request_id "
        "TEXT,actor_id TEXT,action TEXT,created_at INTEGER)");
    J spaces = J::array({{{"id", 1},
                          {"name", "오브 스튜디오"},
                          {"area", "성수 · 서울"},
                          {"category", "촬영 스튜디오"},
                          {"price", 80000},
                          {"capacity", 6},
                          {"description", "오후의 빛이 머무는 내추럴 공간"},
                          {"image", "photo-1600210492486-724fe5c67fb0"}},
                         {{"id", 2},
                          {"name", "룸 오브 선데이"},
                          {"area", "연남 · 서울"},
                          {"category", "촬영 스튜디오"},
                          {"price", 60000},
                          {"capacity", 4},
                          {"description", "느린 일요일을 닮은 따뜻한 장면"},
                          {"image", "photo-1616486338812-3dadae4b4ace"}},
                         {{"id", 3},
                          {"name", "스틸 사운드 룸"},
                          {"area", "합정 · 서울"},
                          {"category", "연습실"},
                          {"price", 30000},
                          {"capacity", 4},
                          {"description", "온전히 몰입하는 나만의 두 시간"},
                          {"image", "photo-1497366754035-f200968a6e72"}}});
    std::string setupKey;
    auto keyfile = root / "data/owner-setup-key.txt";
    if (fs::exists(keyfile)) {
      std::ifstream f(keyfile);
      f >> setupKey;
    } else {
      setupKey = randomKey();
      std::ofstream(keyfile) << setupKey;
    }
    httplib::Server app;
    app.set_payload_max_length(16384);
    app.set_read_timeout(10, 0);
    app.set_write_timeout(10, 0);
    app.set_default_headers(
        {{"X-Content-Type-Options", "nosniff"},
         {"Referrer-Policy", "same-origin"},
         {"X-Frame-Options", "DENY"},
         {"Cache-Control", "no-store"},
         {"Content-Security-Policy",
          "default-src 'self'; img-src 'self' https://images.unsplash.com "
          "data:; style-src 'self'; script-src 'self'; connect-src 'self'; "
          "frame-ancestors 'none'; base-uri 'self'; form-action 'self'"}});
    std::map<std::string, std::pair<long long, int>> attempts;
    auto route = [&](auto fn) {
      return [&, fn](const httplib::Request &r, httplib::Response &res) {
        std::lock_guard<std::recursive_mutex> lock(mx);
        try {
          res.set_content(fn(r).dump(), "application/json; charset=utf-8");
        } catch (const Error &e) {
          res.status = e.status;
          res.set_content(J({{"error", e.message}}).dump(),
                          "application/json; charset=utf-8");
        } catch (const J::exception &e) {
          std::cerr << r.path << ": JSON error " << e.id << std::endl;
          res.status = 400;
          res.set_content(J({{"error", "입력 형식을 확인해주세요."}}).dump(),
                          "application/json; charset=utf-8");
        } catch (const std::exception &e) {
          std::cerr << e.what() << std::endl;
          res.status = 500;
          res.set_content(
              J({{"error", "서버 처리에 실패했어요. 다시 시도해주세요."}})
                  .dump(),
              "application/json; charset=utf-8");
        }
      };
    };
    app.Get("/api/health", route([&](auto &r) {
              return J{{"ok", true}, {"service", "PLYT C++"}};
            }));
    app.Get("/api/spaces", route([&](auto &r) {
              return J{{"spaces", spaces}, {"pilot", true}};
            }));
    auto auth = [&](const httplib::Request &r, bool signup) {
      auto &a = attempts[r.remote_addr];
      if (now() - a.first > 60)
        a = {now(), 0};
      require(++a.second <= 20, 429,
              "로그인 시도가 많아요. 1분 후 다시 시도해주세요.");
      auto j = J::parse(r.body);
      auto email = lower(field(j, "email", 254));
      auto pass = field(j, "password", 128);
      require(std::regex_match(email, std::regex("[^ @]+@[^ @]+\\.[^ @]+")),
              400, "이메일 형식을 확인해주세요.");
      if (signup) {
        require(pass.size() >= 8, 400, "비밀번호는 8자 이상 입력해주세요.");
        require(sql("SELECT id FROM users WHERE email=?", {email}).empty(), 409,
                "이미 가입된 이메일이에요.");
        auto role = std::string("customer");
        if (j.value("owner", false)) {
          require(same(j.value("setupKey", std::string()), setupKey), 403,
                  "사장님 등록 코드를 확인해주세요.");
          require(sql("SELECT id FROM users WHERE role='owner'").empty(), 409,
                  "이미 사장님 계정이 있어요.");
          role = "owner";
        }
        auto salt = randomKey();
        sql("INSERT INTO users VALUES(?,?,?,?,?,?)",
            {randomKey(), email, field(j, "name", 80), role, salt,
             hashPassword(pass, salt)});
      }
      auto rows = sql("SELECT * FROM users WHERE email=?", {email});
      require(!rows.empty(), 401, "이메일 또는 비밀번호를 확인해주세요.");
      auto u = rows[0];
      require(same(u["password"], hashPassword(pass, u["salt"])), 401,
              "이메일 또는 비밀번호를 확인해주세요.");
      auto token = randomKey();
      sql("DELETE FROM sessions WHERE expires<=?", {now()});
      sql("INSERT INTO sessions VALUES(?,?,?)",
          {token, u["id"], now() + 604800});
      u.erase("password");
      u.erase("salt");
      return J{{"token", token}, {"user", u}};
    };
    app.Post("/api/auth/register",
             route([&](auto &r) { return auth(r, true); }));
    app.Post("/api/auth/login", route([&](auto &r) { return auth(r, false); }));
    app.Get("/api/me", route([&](auto &r) { return user(r); }));
    app.Post("/api/auth/logout", route([&](auto &r) {
               user(r);
               sql("DELETE FROM sessions WHERE token=?",
                   {r.get_header_value("Authorization").substr(7)});
               return J{{"ok", true}};
             }));
    app.Get(
        "/api/favorites", route([&](auto &r) {
          auto u = user(r);
          J ids = J::array();
          for (auto &v :
               sql("SELECT space_id FROM favorites WHERE user_id=?", {u["id"]}))
            ids.push_back(v["space_id"]);
          return J{{"ids", ids}};
        }));
    app.Post("/api/favorites", route([&](auto &r) {
               auto u = user(r);
               auto j = J::parse(r.body);
               int id = j.at("spaceId");
               require(id >= 1 && id <= 3, 400, "공간을 확인해주세요.");
               if (j.at("saved").get<bool>())
                 sql("INSERT OR IGNORE INTO favorites VALUES(?,?)",
                     {u["id"], id});
               else
                 sql("DELETE FROM favorites WHERE user_id=? AND space_id=?",
                     {u["id"], id});
               return J{{"ok", true}};
             }));
    app.Get("/api/requests",
            route([&](auto &r) { return J{{"requests", requests(user(r))}}; }));
    app.Post(
        "/api/requests", route([&](auto &r) {
          auto u = user(r);
          auto j = J::parse(r.body);
          int sid = j.at("spaceId"), duration = j.at("duration"),
              budget = j.at("budget");
          require(sid >= 1 && sid <= 3 && budget >= 0 && budget <= 100000, 400,
                  "공간과 추가 부담 한도를 확인해주세요.");
          auto d = field(j, "date"), t = field(j, "time");
          dateTime(d, t, duration);
          auto existing =
              sql("SELECT body FROM requests WHERE requester_id=?", {u["id"]});
          for (auto &v : existing) {
            auto b = J::parse(v["body"].template get<std::string>());
            require(!(b["spaceId"] == sid && b["date"] == d && b["time"] == t &&
                      b["status"] != "cancelled" && b["status"] != "declined"),
                    409, "같은 시간의 요청이 이미 있어요.");
          }
          j = {{"id", randomKey().substr(0, 24)},
               {"spaceId", sid},
               {"space", spaces[sid - 1]["name"]},
               {"requesterId", u["id"]},
               {"requesterName", u["name"]},
               {"date", d},
               {"time", t},
               {"duration", duration},
               {"budget", budget},
               {"basePrice",
                spaces[sid - 1]["price"].template get<int>() * duration / 120},
               {"status", "pending"},
               {"createdAt", now()},
               {"updatedAt", now()}};
          sql("INSERT INTO requests VALUES(?,?,NULL,?,?)",
              {j["id"], u["id"], j.dump(), now()});
          event(j["id"], u, "pending");
          return j;
        }));
    app.Post(
        R"(/api/requests/([a-z0-9]+)/action)", route([&](auto &r) {
          auto u = user(r);
          auto id = r.matches[1].str();
          auto rows = sql("SELECT body FROM requests WHERE id=?", {id});
          require(!rows.empty(), 404, "요청을 찾을 수 없어요.");
          auto b = J::parse(rows[0]["body"].template get<std::string>());
          auto j = J::parse(r.body);
          auto action = field(j, "action");
          bool owner = u["role"] == "owner",
               requester = u["id"] == b["requesterId"],
               recipient =
                   b.contains("recipientId") && u["id"] == b["recipientId"];
          require(owner || requester || recipient, 403,
                  "접근할 수 없는 요청이에요.");
          std::string status = b["status"];
          if (action == "cancel") {
            require(requester, 403, "요청자만 취소할 수 있어요.");
            require(status != "confirmed" && status != "cancelled" &&
                        status != "declined",
                    409, "이미 종료된 요청이에요.");
            b["status"] = "cancelled";
          } else if (action == "propose") {
            require(owner, 403, "사장님만 제안할 수 있어요.");
            require(status == "pending", 409,
                    "접수된 요청에만 제안할 수 있어요.");
            auto email = lower(field(j, "recipientEmail", 254));
            auto people =
                sql("SELECT id,name FROM users WHERE email=?", {email});
            require(!people.empty(), 400,
                    "기존 예약자의 가입 이메일을 확인해주세요.");
            require(people[0]["id"] != b["requesterId"] &&
                        people[0]["id"] != u["id"],
                    400, "요청자와 다른 기존 예약자를 선택해주세요.");
            auto date = field(j, "alternativeDate"),
                 time = field(j, "alternativeTime");
            dateTime(date, time, b["duration"]);
            require(date != b["date"] ||
                        !overlap(time, b["duration"], b["time"], b["duration"]),
                    400, "기존 시간과 겹치지 않는 대체 시간을 선택해주세요.");
            dateTime(b["date"], b["time"], b["duration"]);
            int reward = j.at("reward");
            require(reward >= 0 && reward <= b["budget"].template get<int>(),
                    400, "보상은 고객 추가 부담 한도 이하여야 해요.");
            b["recipientId"] = people[0]["id"];
            b["recipientName"] = people[0]["name"];
            b["alternativeDate"] = date;
            b["alternativeTime"] = time;
            b["reward"] = reward;
            b["bookingReference"] = field(j, "bookingReference", 120);
            b["expiresAt"] = now() + 172800;
            b["status"] = "proposed";
          } else if (action == "accept" || action == "decline") {
            require(recipient || requester, 403,
                    "제안 당사자만 응답할 수 있어요.");
            require(b.contains("expiresAt") &&
                        now() < b["expiresAt"].template get<long long>(),
                    409, "제안 응답 기한이 지났어요.");
            if (action == "decline") {
              require(status == "proposed" || status == "accepted_a", 409,
                      "응답 가능한 제안이 아니에요.");
              b["status"] = "declined";
            } else if (recipient) {
              require(status == "proposed", 409, "이미 응답한 제안이에요.");
              b["status"] = "accepted_a";
            } else {
              require(status == "accepted_a", 409,
                      "기존 예약자의 수락을 기다리고 있어요.");
              b["status"] = "accepted_b";
            }
          } else if (action == "confirm") {
            require(owner, 403, "사장님만 확정할 수 있어요.");
            require(status == "accepted_b", 409, "양측 수락이 필요해요.");
            require(now() < b["expiresAt"].get<long long>(), 409,
                    "제안 확정 기한이 지났어요.");
            require(j.value("originalSystemUpdated", false), 400,
                    "원래 예약 시스템 반영을 먼저 확인해주세요.");
            b["confirmationReference"] = field(j, "confirmationReference", 120);
            dateTime(b["date"], b["time"], b["duration"]);
            dateTime(b["alternativeDate"], b["alternativeTime"], b["duration"]);
            for (auto &v : sql("SELECT body FROM requests WHERE id<>?", {id})) {
              auto x = J::parse(v["body"].template get<std::string>());
              if (x["status"] != "confirmed" || x["spaceId"] != b["spaceId"])
                continue;
              for (auto prefix : {std::string(""), std::string("alternative")})
                for (auto xp : {std::string(""), std::string("alternative")}) {
                  auto dk = prefix.empty() ? "date" : "alternativeDate",
                       tk = prefix.empty() ? "time" : "alternativeTime";
                  auto xd = xp.empty() ? "date" : "alternativeDate",
                       xt = xp.empty() ? "time" : "alternativeTime";
                  require(!(b[dk] == x[xd] && overlap(b[tk], b["duration"],
                                                      x[xt], x["duration"])),
                          409, "이미 확정된 이용 시간과 겹쳐요.");
                }
            }
            b["status"] = "confirmed";
            b["paymentStatus"] = "not_integrated";
            b["rewardStatus"] = "not_paid";
          } else
            throw Error{400, "지원하지 않는 동작이에요."};
          b["updatedAt"] = now();
          sql("BEGIN IMMEDIATE");
          try {
            sql("UPDATE requests SET recipient_id=?,body=? WHERE id=?",
                {b.value("recipientId", J()), b.dump(), id});
            event(id, u, b["status"]);
            sql("COMMIT");
          } catch (...) {
            sql("ROLLBACK");
            throw;
          }
          return b;
        }));
    app.Get(
        R"(/api/requests/([a-z0-9]+)/events)", route([&](auto &r) {
          auto u = user(r);
          auto rows =
              sql("SELECT requester_id,recipient_id FROM requests WHERE id=?",
                  {r.matches[1].str()});
          require(!rows.empty(), 404, "요청이 없어요.");
          require(u["role"] == "owner" || u["id"] == rows[0]["requester_id"] ||
                      u["id"] == rows[0]["recipient_id"],
                  403, "접근할 수 없어요.");
          return J{{"events", sql("SELECT action,created_at FROM events WHERE "
                                  "request_id=? ORDER BY id",
                                  {r.matches[1].str()})}};
        }));
    app.set_mount_point("/", (root / "web").u8string());
    app.set_error_handler([](auto &r, auto &res) {
      if (res.body.empty())
        res.set_content(J({{"error", "페이지를 찾을 수 없어요."}}).dump(),
                        "application/json; charset=utf-8");
    });
    int port = std::getenv("PORT") ? std::stoi(std::getenv("PORT")) : 8080;
    std::string host =
        std::getenv("PLYT_HOST") ? std::getenv("PLYT_HOST") : "127.0.0.1";
    std::cout << "PLYT C++ listening on http://" << host << ":" << port
              << std::endl;
    std::cout << "Owner setup code: data/owner-setup-key.txt (local file only)"
              << std::endl;
    return app.listen(host, port) ? 0 : 1;
  } catch (const std::exception &e) {
    std::cerr << e.what() << std::endl;
    return 1;
  }
}

