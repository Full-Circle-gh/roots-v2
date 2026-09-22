# 货拉拉 (Huolala) open platform — API reference

Transcribed from `open.huolala.cn/#/doc/api` on 2026-09-22 from a logged-in
session. **This is a copy of a vendor document, not a design.** It records what
the portal said on that date so a session without network access to
`huolala.cn` can work from real field names instead of guessing.

The container this repo builds in cannot reach `huolala.cn` — the environment's
network policy allows GitHub and package registries only. Re-transcribe from the
portal rather than assuming this file is current.

## Business categories (业务分类)

The portal splits its docs four ways:

1. 货拉拉APP业务   ← **everything below is from here**
2. 货拉拉企业版APP  ← separate category, has its own callback page
3. 零担业务
4. 拉拉券

**RESOLVED 2026-09-22: our account is 货拉拉APP业务**, so the endpoints below
apply. The company books through the ordinary 货拉拉 app on a single company
account that carries 企业认证 (enterprise verification). **企业认证 inside the
consumer app is NOT 货拉拉企业版APP** — that is a separate product with its own
app and its own doc category. The distinction matters because the OAuth flow
below authorises a 货拉拉用户账户, i.e. the phone number that books in the
consumer app, which is the same account these endpoints read.

## Gateway

| Environment | URL |
|---|---|
| 沙箱 (sandbox) | `https://openapi-pre.huolala.cn/v1` |
| 生产 (production) | `https://openapi.huolala.cn/v1` |

All calls POST JSON. Headers: `Accept: application/json`,
`Content-type: application/json`, `Charset: utf-8`.

Official SDKs: Java `https://gitee.com/hll-open/java-sdk`,
PHP `https://gitee.com/hll-open/php-sdk`. No Node SDK — we write our own client.

## Common request parameters (系统级)

| Param | Notes |
|---|---|
| `api_method` | endpoint method name, e.g. `u-order-detail` |
| `api_version` | fixed `"1.0"` |
| `app_key` | from `HUOLALA_APP_KEY` |
| `access_token` | **only on 需授权接口** — every order endpoint needs it |
| `timestamp` | unix seconds, valid 60s |
| `nonce_str` | random, no reuse within 60s |
| `signature` | see below |
| `api_data` | business params as a **JSON string**, not a nested object |

## Signing (request)

1. Take all request params except `signature`, sort by parameter name in ASCII order.
2. Join as `key=value&key=value`.
3. Append the `app_secret` **value** directly to the end — no `&`, no `app_secret=` key.
4. MD5, **32-char lowercase**. That is the signature.

Notes:
- Empty-valued params are **excluded** from the sort (e.g. an empty `access_token`).
- `api_data` is signed as its raw JSON string.
- Example sorted order: `access_token, api_data, api_method, api_version, app_key, nonce_str, timestamp`.

## Callbacks (消息回调)

Registered **per order**, via the `notify_url` field on `u-order-request` (下单).
There is no console-side registration. Sandbox additionally requires emailing
Huolala the callback domain/IP + port for 外网准出申请.

**Consequence: an order booked by hand in the Huolala app carries no
`notify_url`, so it produces no callbacks.** Callbacks only exist for orders we
place through the API.

Payload (POST JSON):

| Field | Type | Notes |
|---|---|---|
| `serial_no` | string(32) | unique message id — dedupe on this |
| `action` | string | `order_update` or `blii_update` (sic — match the typo literally) |
| `create_time` | long | unix **milliseconds** |
| `out_order_id` | string | our external order id, passed at 下单 |
| `out_user_id` | string | our external user id, passed at 下单 |
| `data.event_type` | string | see table below |
| `data.order_display_id` | string | Huolala's order number |
| `data.order_status` | int | **marked 已废弃 (deprecated)** — the doc says branch on `event_type`, not this |
| `data.canceled_order_info` | object | only on `ORDER_CANCELLED`; `.scene_desc`, `.scene` |

Required response body: `{"serial_no":"<same serial_no>"}`. Anything else counts
as failure — Huolala retries several times, then gives up.

### `event_type` values (`action = order_update`)

| event_type | Meaning |
|---|---|
| `prepay_ok` | 订单支付完成，正在为您配对 |
| `pickup` | 司机已接单 |
| `loading` | 装货中 |
| `loaded` | 司机装货完成，开始运送 |
| `unloading` | 到达卸货地，卸货中 |
| `unload_finish` | 前往下一个卸货地 |
| `order_complete` | 司机完成卸货，订单运送完成 |
| `order_auto_complete` | 48h no action after delivery → auto complete |
| `send_bill` | 发送账单 |
| `rear_pay_ok` | 已支付司机账单，订单最终完成 |
| `auto_confirm_bill_pay` | 系统自动确认账单支付 |
| `cash_received` | 费用已结清，订单完成 |
| `order_cancel` | 用户已取消订单 |
| `ORDER_CANCELED` | 订单取消(全场景) — the doc recommends this one. Spelled `ORDER_CANCELLED` elsewhere on the same page |
| `driver_reject` | 司机接单后拒绝 (2nd rejection auto-cancels) |
| `order_timeout` | 无司机响应，已自动取消 |
| `no_load_cancel` | 5 days without 开始装货 → auto cancel (sandbox: 40 min) |
| `no_complete_cancel` | 10 days without 卸货 → auto cancel |
| `set_order_abnormal` | 异常完成 |

### Callback signature — DO NOT TRUST IT

The portal's own rule: sort params except `signature`, join `key=value&key=value`,
MD5 32-lowercase. Then, verbatim:

> 注意：**不用拼接secret，所有的参数都参与计算，包含空值。**

The secret is **not** used. That means the signature proves only that the sender
could run MD5 — anyone who learns the callback URL can forge a valid one.

**Rule for our implementation:** treat a callback as an untrusted "something
changed" ping. Never read business state out of the body. On receipt, call
`u-order-detail` ourselves (signed with our secret) and trust only that.
Additionally: use an unguessable `notify_url` path, and dedupe on `serial_no`.

The doc also never states how the nested `data` object is stringified for
signing, which is a second reason not to depend on it.

## `u-order-detail` — 查询订单详情

POST, **needs `access_token`**. Request: `order_display_id` (string).

Response `data` (selected — full table in the portal):

| Field | Type | Notes |
|---|---|---|
| `order_display_id` | string | |
| `order_status` | int | see status table |
| `order_status_name` | string | |
| `vehicle_type_name` | string | 车型名称 |
| `addr_info[]` | array | first = pickup, last = dropoff |
| `addr_info[].lat_lon.lat/lon` | double | **GCJ-02** |
| `addr_info[].contacts_name` / `.contacts_phone_no` | string | |
| `order_time` / `create_time` / `complete_time` | long | unix **seconds** |
| `total_price_fen` | int | 分 |
| `driver_info.name` | string | surname only, e.g. 刘师傅 |
| `driver_info.license_plate` | string | **masked**, e.g. 粤B**517 |
| `driver_info.physics_vehicle_name` | string | e.g. 面包车 |
| `driver_info.driver_phone_no` | string | may be a virtual number |
| `driver_info.phone_no_type` | int | 1 real, 2 virtual, 3 客服 |
| `driver_info.lat_lon.lat/lon` | double | **WGS-84 — different datum from the addresses** |
| `receipt_url` | array | 拍照回单 (proof-of-delivery photos) |

Return codes: `0` success, `30012` 订单ID错误.

### Two things this response does NOT have

1. **No ETA.** There is no 预计到达时间 field anywhere in the response. Huolala
   does not compute one for us.
2. **No unmasked plate.** `license_plate` hides the middle, e.g. 粤B**517.

### Datum mismatch — load-bearing

`addr_info[].lat_lon` is **GCJ-02**. `driver_info.lat_lon` is **WGS-84**.
This repo is GCJ-02 everywhere (Qingyun's `rider_lat/lng`, `lib/geocode.js`,
the mini-app map picker). There is currently **no WGS-84 → GCJ-02 helper in the
repo**. One must be written, and it must be correct: an unconverted WGS-84 pin
lands roughly 300–500 m off in Guangzhou, which is a different block.

## `order_status` values

| Code | Meaning | Related event_type |
|---|---|---|
| 6 | 订单未支付 | — |
| 0 | 配对司机中 | `prepay_ok` |
| 1 | 前往发货地 / 待装货 | `pickup` |
| 15 | 装货中 | `loading` |
| 7 | 运送中 | `loaded` |
| 16 | 卸货中 | `unloading` |
| 10 | 运送完成 | — |
| 13 | 客户确认账单中 | `send_bill` / `rear_pay_ok` |
| 14 | 账单申诉中 | — |
| 2 | 最终正常完成 | `order_complete` |
| 18 | 待支付取消 | — |
| 5 | 订单逾时取消 | `order_timeout` |
| 4 | 司机拒绝取消 | `driver_reject` |
| 3 | 用户取消 | `order_cancel` |
| 8 | 5天未装货取消 | `no_load_cancel` |
| 9 | 10天未完成取消 | `no_complete_cancel` |
| 11 | 虚报订单 | `set_order_abnormal` |

The portal's prose ("60分钟内没有司机接单") contradicts its own diagram
(小车 +30 min / 大车 +4 h). Do not hardcode these timers.

## `u-order-list` — 查询订单列表

POST, **needs `access_token`**. Returns the authorised account's orders from the
**last 3 months only**.

Request: `status_group` (1 进行中 / 2 已完成 / 3 已取消), `order_status` (array),
`order_time_s`, `order_time_e`, `page_no`, `page_size` (**max 20**; the doc warns
deep pagination gets rate-limited).

Response: `record_total`, `page_total`, `page_no`, `page_size`, and `order_list[]`
with `order_display_id`, `order_time`, `create_time`, `total_price_fen`,
`order_status`, `order_vehicle_name`, and `addr_info[]` (GCJ-02, includes
`city_name`).

**No driver info and no driver position in the list** — `u-order-detail` is the
only source for those.

### VENDOR RULING 2026-09-22: it returns API-placed orders ONLY

The portal's own wording — 用户可查询账户下历史订单列表(3个月内) — reads as though
it returns everything the account booked. **It does not.** Asked directly, 货拉拉
市场中心 (罗莺 Norah Luo, `norah.luo@huolala.cn`) answered:

> 已收到贵司的咨询邮件，但贵司需求无法满足，因开放平台接口不支持查询非api接口
> 形式下单的订单，请知悉。

*"Your requirement cannot be met, because the open platform API does not support
querying orders not placed through the API."*

**This forecloses reading orders that staff book by hand in the 货拉拉 app.**
Any design that wants order status or driver position must place the order
through `u-order-request` itself. There is no read-only integration.

Doc types are unreliable here: `lat`/`lon` are declared `string` but the examples
are numbers; `order_status` is declared `array` but the example sends `"0"`.
Parse defensively.

## `u-order-request` — 下单

POST, needs `access_token`. The portal's parameter table has **no 是否必须
column**, so required-vs-optional is not documented. Confirm against the sandbox.

Listed params include: `city_id`, `city_info_revision` (from `u-city-info`),
`order_vehicle_id`, `addr_info[]` (first = pickup, last = dropoff, max 10, GCJ-02),
`order_time`, `contact_name`, `contact_phone_no`, `out_order_id` (our idempotency
key), `out_user_id`, `total_price_fen`, `price_calculate_id`,
`price_item_encryption`, `vehicle_attr`, `commodity_info`, `pay_type`
(4 = 账户余额, 0 = third-party), **`notify_url`**, `coupon_id`.

Optional-looking: `vehicle_std`, `spec_req`, `phone_bind_strategy`, `ip`,
`remark`, `invoice_type`, `order_service_type`, `ref`, `themis_data`.

**A quote must come first.** `price_calculate_id`, `price_item_encryption`,
`vehicle_attr`, `commodity_info` and (if a coupon applied) `coupon_id` all come
from 估价（多品类）`u-price-multiCalculate`. Booking through the API therefore
means implementing quoting too.

The portal's lat/lon example values are **swapped** (shows lon≈22.6, lat≈114.0
for Shenzhen; the truth is lat≈22, lon≈114).

## 用户授权 — how `access_token` is obtained

Standard OAuth 2.0 authorization-code flow. Every order endpoint
(`u-order-detail`, `u-order-list`, `u-order-request`) is marked 需用户授权 and
will not work without a token.

Prerequisites the portal states: a registered developer account, and an app in
已上线 state holding an `app_key` / `app_secret`.

### The flow

1. **Send the account owner to Huolala's consent page** (GET, in a browser):
   `https://open.huolala.cn/#/oauth/authorize?response_type=code&client_id=<app_key>&redirect_uri=<our callback>&isSandbox=false`
   All four params are required. `isSandbox=true` for the sandbox, where the SMS
   code is always `6666`.
2. **They log in** with phone number + SMS code and approve. The page carries a
   创建账户（当账户不存在时） checkbox that will create an account if none exists.
3. **Huolala redirects** to `redirect_uri?code=<CODE>`.
4. **Exchange the code** (GET):
   `https://open.huolala.cn/oauth/token?grant_type=authorization_code&client_id=<app_key>&code=<CODE>&isSandbox=false`

Response `data`: `auth_mobile` (the authorising phone number), `access_token`,
`refresh_token`, `auth_end_time` (e.g. `2020-06-07 15:35:08` — a date-time string
with **no timezone**; assume Beijing).

### Lifetime and refresh

- **`access_token` lasts 3 months.** The exact moment is `auth_end_time`.
- **`refresh_token` is not guaranteed.** The portal qualifies it: 对于具有
  "获取Refresh_token权限"的应用. Only apps granted refresh permission receive one.
- Refresh (GET):
  `https://open.huolala.cn/oauth/token?grant_type=refresh_token&client_id=<app_key>&refresh_token=<token>`
- **The refresh must happen while the access_token is still valid.** Once it
  expires there is no refresh path — a human logs in again.
- **Both tokens rotate on every refresh.** The call returns a new `access_token`
  AND a new `refresh_token`; the old pair stops working.

### Operational rules this forces on us

1. **Confirm refresh permission before building** — email `openapi@huolala.cn`.
   Without it, someone re-authorises by hand every three months, and that needs
   an alarm or it will simply stop working one morning with no warning.
2. **Save both tokens in a single write.** They rotate together; a crash between
   writing one and the other locks the account out until a human re-authorises.
3. **Refresh early — weekly, not on the last day.** A three-month window means a
   missed refresh is invisible for months and then terminal.
4. **Alert on a failed refresh.** Silence here is indistinguishable from health.

### Tokens are per account, per app — the load-bearing constraint

A token belongs to one Huolala login (`auth_mobile`) and one `app_key`. Sandbox
and production tokens are separate.

**Consequence: `u-order-list` only ever returns orders booked by the account that
authorised.** A van booked on a staff member's personal Huolala account is
invisible to us. Any design that reads orders rather than placing them requires
the booking to happen on one known company account.

### Doc defects noted at transcription

- `app_secret` is never used in the token calls — the code exchange sends only
  `client_id` + `code`. So `redirect_uri` must be HTTPS and the code exchanged
  immediately.
- The sandbox host is described two ways: the refresh table says
  `open-pre.huolala.cn/oauth/token`, the surrounding text says
  `open.huolala.cn` with `isSandbox=true`. Test both.
- The refresh section points at a "第七步" and an `expire_in` field. Neither
  exists; only `auth_end_time` does.


## Not yet transcribed

- **估价 `u-price-multiCalculate`** — required before 下单.
- **企业版 endpoints and its separate callback page**, if our account is 企业版.

## Credentials

`HUOLALA_APP_KEY` and `HUOLALA_APP_SECRET` as deploy environment variables,
following `JD_APP_KEY` / `ELEME_APP_SECRET`. Never committed, never in chat.
