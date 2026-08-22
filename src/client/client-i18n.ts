/**
 * 客户端 i18n 字典：im-gateway 设置页面的中英文翻译。
 *
 * 通过 ctx.locale.register('im-gateway', dicts) 注册，
 * 组件中用 const t = ctx.locale.bind('im-gateway') 获取翻译函数。
 *
 * @module im-gateway/client-i18n
 */

export const zh = {
  // ── index.ts ──
  'section.label': 'IM 通道',

  // ── ImChannelsSection.ts ──
  'page.title': 'IM 通道',
  'btn.add': '添加通道',
  'state.loading': '加载中…',
  'state.empty': '暂无通道，点击右上角「添加通道」开始接入',
  'error.loadFailed': '加载配置失败',
  'error.refreshFailed': '刷新配置失败',
  'error.saveFailed': '保存失败（{0}）',
  'badge.connected': '已连接',
  'badge.disabled': '未启用',
  'toggle.disable': '停用',
  'toggle.enable': '启用',
  'btn.edit': '编辑',
  'btn.delete': '删除',
  'delete.title': '删除通道',
  'delete.confirm': '确定删除该通道？其配置将被移除。',
  'btn.cancel': '取消',
  'btn.confirmDelete': '删除',

  // ── ImChannelModal.ts ──
  'type.dingtalk': '钉钉',
  'type.qq': 'QQ',
  'type.weixin': '个人微信',
  'modal.editTitle': '编辑通道 · {0}',
  'modal.addTitle': '添加通道',
  'btn.close': '关闭',
  'field.channelType': '渠道类型',
  'field.channelName': '通道名称',
  'field.namePlaceholder': '如：{0}主机器人',
  'qr.success': '✅ 扫码登录成功，凭据已自动填入下方字段，点击「保存」生效。',
  'qr.alt': '登录二维码',
  'qr.qqHint': '请用手机 QQ 扫码绑定机器人',
  'qr.weixinHint': '请用手机微信扫码',
  'qr.fallback': '；若图片无法显示，可点击下方链接扫码',
  'qr.verifyPlaceholder': '输入配对码',
  'btn.confirm': '确认',
  'qr.bound.qq': '已绑定机器人凭据（AppID 已自动填入）。如需更换，重新扫码即可。',
  'qr.bound.weixin': '已绑定微信凭据。如需更换，重新扫码即可。',
  'qr.unbound.qq': '尚未配置机器人凭据？扫码绑定，免去在 QQ 开放平台手动创建',
  'qr.unbound.weixin': '尚未绑定微信？扫码连接个人微信账号',
  'qr.fetching': '获取二维码中…',
  'qr.scanLogin': '扫码登录（{0}）',
  'qr.startFailed': '扫码登录启动失败',
  'btn.save': '保存',
  'btn.saving': '保存中…',
}

export const en = {
  // ── index.ts ──
  'section.label': 'IM Channels',

  // ── ImChannelsSection.ts ──
  'page.title': 'IM Channels',
  'btn.add': 'Add Channel',
  'state.loading': 'Loading…',
  'state.empty': 'No channels yet. Click "Add Channel" above to get started.',
  'error.loadFailed': 'Failed to load config',
  'error.refreshFailed': 'Failed to refresh config',
  'error.saveFailed': 'Save failed ({0})',
  'badge.connected': 'Connected',
  'badge.disabled': 'Disabled',
  'toggle.disable': 'Disable',
  'toggle.enable': 'Enable',
  'btn.edit': 'Edit',
  'btn.delete': 'Delete',
  'delete.title': 'Delete Channel',
  'delete.confirm': 'Are you sure you want to delete this channel? Its configuration will be removed.',
  'btn.cancel': 'Cancel',
  'btn.confirmDelete': 'Delete',

  // ── ImChannelModal.ts ──
  'type.dingtalk': 'DingTalk',
  'type.qq': 'QQ',
  'type.weixin': 'WeChat',
  'modal.editTitle': 'Edit Channel · {0}',
  'modal.addTitle': 'Add Channel',
  'btn.close': 'Close',
  'field.channelType': 'Channel Type',
  'field.channelName': 'Channel Name',
  'field.namePlaceholder': 'e.g. {0} Main Bot',
  'qr.success': '✅ QR login successful. Credentials auto-filled. Click "Save" to apply.',
  'qr.alt': 'Login QR Code',
  'qr.qqHint': 'Scan with mobile QQ to bind the bot',
  'qr.weixinHint': 'Scan with mobile WeChat',
  'qr.fallback': '; if the image fails to load, click the link below to scan',
  'qr.verifyPlaceholder': 'Enter pairing code',
  'btn.confirm': 'Confirm',
  'qr.bound.qq': 'Bot credentials bound (AppID auto-filled). Re-scan to switch.',
  'qr.bound.weixin': 'WeChat credentials bound. Re-scan to switch.',
  'qr.unbound.qq': 'No bot credentials? Scan to bind — no need to create manually on QQ Open Platform.',
  'qr.unbound.weixin': 'Not bound yet? Scan to connect your WeChat account.',
  'qr.fetching': 'Fetching QR code…',
  'qr.scanLogin': 'QR Login ({0})',
  'qr.startFailed': 'QR login failed to start',
  'btn.save': 'Save',
  'btn.saving': 'Saving…',
}