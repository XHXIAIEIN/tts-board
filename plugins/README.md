# 插件

插件是这个文件夹下的一个子文件夹，放一个使用 tts-board 页面的项目。Git 忽略这里除本说明以外的全部内容，所以项目的剧本、音频和后端只留在本机，插件文件夹也可以是一个单独的 Git 仓库。

一个插件放一个项目的 `data/`，格式和仓库的示例 `data/` 相同，见 README 的「项目数据」。插件可以带自己的后端，这个后端要做三件事：

1. 在 `/` 提供仓库的 `web/`
2. 在 `data/` 提供插件自己的 `data/`
3. 实现 README「后端接口」里的接口

后端从自己的文件路径找到 `web/`，例如向上找最近的含有 `web/index.html` 的文件夹，这样仓库移到别处时不用改设置。找不到页面时，后端应当在启动时退出并说明它找过哪个文件夹。

一个插件的布局，例如：

```
plugins/my-project/
├── data/
│   ├── project.json
│   └── scripts/
└── backend/          可选，实现「后端接口」
```

没有后端，或者只想检查剧本的写法时，让模拟后端读插件的数据：

```bash
python server/mock_server.py --data plugins/my-project/data
```
