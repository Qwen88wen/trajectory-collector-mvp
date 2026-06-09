# 轨迹采集 MVP

一个离线优先的手机网页/PWA，用于采集整段 GPS 路线。

## 功能

- Start 后读取手机 GPS。
- 默认每 1 秒保存一次，或移动超过 3 米时保存一次 `lng / lat / timestamp / accuracy / speed / heading / altitude`。
- 保留设备原始 `speed / heading / altitude`，并根据相邻 GPS 点计算 `computedSpeed / computedHeading / distanceFromPrevious / timeFromPrevious`。
- 记录中会显示当前速度、当前方向，以及速度/方向使用的是设备值还是计算值。
- 地图画线会过滤明显不可靠的显示点，例如 `accuracy > 30m`、短时间大跳点或超过 120 km/h 的异常速度；原始 GPS 点仍会完整保存和上传。
- 记录面板会分开显示 `Raw Points`、`Display Points` 和 `Filtered`，方便判断 GPS 是否有采集到、以及有多少点只是不参与地图画线。
- 记录面板会显示 `Moving Time`、`Stopped Time` 和 `Avg Speed`；移动时间按可靠显示点相邻段速度超过 1 km/h 计算，平均速度按可靠显示距离 / 总时长计算。
- 车辆测试统计会显示 `Display Distance`、`Moving Avg` 和 `Max Speed`，全部基于可靠显示点计算，避免漂移点影响速度/距离判断。
- 地图会标记路线起点 `S`、录制中的当前位置 `C`，以及停止后的终点 `E`。
- 录制中会在当前位置 `C` 旁画方向箭头；方向优先使用设备 `heading`，没有时使用 `computedHeading`。
- Stop 后结束当前路线并标记为待上传。
- 使用离线画布显示刚刚走过的轨迹线。
- 有网络时 POST 上传；离线或上传失败时保存在 IndexedDB，之后打开页面、恢复网络或点击 Sync 会重试。
- 导出 GeoJSON，可直接导入 geojson.io 查看轨迹。

## 本地运行

```powershell
python -m http.server 5173
```

然后在浏览器打开：

```text
http://localhost:5173
```

GPS、PWA、Service Worker 需要安全上下文。桌面测试可以用 `localhost`；iOS/Android 真机建议部署到 HTTPS 域名后访问。

普通 Python 静态服务不会运行 `api/tracks.js`。上传接口需要部署到 Vercel 后测试，或在安装 Vercel CLI 后使用 `vercel dev` 本地测试。

## 免费部署：Supabase + Vercel

### 1. 创建 Supabase 表

1. 新建 Supabase Free project。
2. 打开 Supabase SQL Editor。
3. 复制并运行 `supabase/schema.sql`。

这会创建 `public.tracks` 表，用来保存整条轨迹的点数组、距离、开始/结束时间和客户端信息。

### 2. 配置 Vercel 环境变量

在 Vercel Project Settings -> Environment Variables 添加：

```text
SUPABASE_URL=https://你的项目ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=你的 service_role key
```

`SUPABASE_SERVICE_ROLE_KEY` 只能放在 Vercel 环境变量里，不要写进前端文件，也不要提交到 Git。

可选：

```text
ALLOWED_ORIGIN=https://你的-vercel-domain.vercel.app
```

不设置时 API 会允许任意来源 POST，适合 MVP 快速测试；上线给更多人使用前建议设置。

### 3. 部署到 Vercel

推荐流程：

1. 把这个文件夹推到 GitHub。
2. 在 Vercel 新建 Project，导入这个 GitHub repo。
3. Framework Preset 选择 Other。
4. Build Command 留空。
5. Output Directory 留空。
6. 添加上面的环境变量。
7. Deploy。

部署后，前端仍然默认上传到：

```text
/api/tracks
```

Vercel 会自动把这个请求交给 `api/tracks.js`，再写入 Supabase。

## 上传接口格式

前端默认上传到：

```text
/api/tracks
```

页面里可以改 `Upload URL`。请求格式：

```json
{
  "id": "track-id",
  "startedAt": "2026-06-05T06:00:00.000Z",
  "stoppedAt": "2026-06-05T06:10:00.000Z",
  "pointCount": 120,
  "distanceMeters": 860,
  "points": [
    {
      "lng": 121.4737,
      "lat": 31.2304,
      "accuracy": 12,
      "timestamp": "2026-06-05T06:00:03.000Z",
      "speed": 1.4,
      "heading": 86,
      "altitude": 8.5,
      "computedSpeed": 1.38,
      "computedHeading": 84.7,
      "distanceFromPrevious": 6.9,
      "timeFromPrevious": 5,
      "speedSource": "device",
      "headingSource": "device"
    }
  ],
  "client": {
    "userAgent": "browser user agent",
    "uploadedAt": "2026-06-05T06:11:00.000Z"
  }
}
```

接口返回任意 `2xx` 状态码即视为同步成功。

Vercel 函数会把字段转换为 Supabase 表字段：

- `startedAt` -> `started_at`
- `stoppedAt` -> `stopped_at`
- `pointCount` -> `point_count`
- `distanceMeters` -> `distance_meters`
- `points` -> `points`
- `client` -> `client`

## 导入到 geojson.io

点击页面里的 `Export GeoJSON`，下载的文件名是：

```text
tracks-YYYY-MM-DD.geojson
```

这个文件是标准 GeoJSON `FeatureCollection`：

- 多个 GPS 点的轨迹导出为 `LineString`
- 只有一个 GPS 点的轨迹导出为 `Point`
- 坐标顺序是 GeoJSON 标准的 `[lng, lat]`

GeoJSON 坐标导出固定使用：

```js
const coordinates = points.map(point => [point.lng, point.lat]);
```

每个新采集的 GPS 点都会保存：

- `lng`: 经度
- `lat`: 纬度
- `timestamp`: 采集时间
- `accuracy`: 水平精度，单位米
- `speed`: 速度，单位米/秒；设备不提供时为 `null`
- `heading`: 航向角，0-360 度；设备不提供时为 `null`
- `altitude`: 海拔，单位米；设备不提供时为 `null`
- `computedSpeed`: App 根据相邻两点距离 / 时间差计算的速度，单位米/秒
- `computedHeading`: App 根据上一点到当前点计算的方向角，0-360 度
- `distanceFromPrevious`: 当前点与上一点之间的距离，单位米
- `timeFromPrevious`: 当前点与上一点之间的时间差，单位秒
- `speedSource`: App 推荐使用的速度来源，可能是 `device`、`computed` 或 `none`
- `headingSource`: App 推荐使用的方向来源，可能是 `device`、`computed` 或 `none`

`Backup JSON` 是本 App 的原始备份格式，不是 GeoJSON，不能直接用 geojson.io 的 GeoJSON 导入。

## 第一版限制

- 不做 GPS 偏移修正、道路纠偏、重复路线识别、断点合并。
- 不缓存离线底图；离线时仍能显示采集到的轨迹线。
- iOS/Android 浏览器在锁屏或长时间后台时可能暂停网页定位，正式采集建议保持页面前台运行。
- Supabase Free 项目长时间不用可能暂停；Vercel/Supabase 免费额度适合 MVP，真实高频采集需要关注用量。
