/**
 * 网页读取权限。
 *
 * 问一次 http/https，之后换网站不再弹授权。不申请 `<all_urls>`：
 * 那会把 chrome://、file:// 也包进去，安装说明更吓人，而我们本来就不读那些页。
 * 每一页仍要用户点「开始伴读」才提取、才外发（BR-03）。
 */
export const PAGE_READ_ORIGINS = ['https://*/*', 'http://*/*'];
