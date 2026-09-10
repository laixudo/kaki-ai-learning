import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, App as AntdApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { bindMessage } from './api/client';
import './styles/global.css';

const basePath = import.meta.env.VITE_BASE_PATH || '/';

function MessageBinder() {
  const { message } = AntdApp.useApp();
  useEffect(() => {
    bindMessage(message);
  }, [message]);
  return null;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          // 与 global.css 的 CSS 变量保持同一套暖色设计系统（柿子橙主色、深棕灰文字）
          colorPrimary: '#ff5a14',
          colorInfo: '#ff5a14',
          colorSuccess: '#6f8550',
          colorWarning: '#bc712f',
          colorError: '#b94b39',
          colorText: '#382d27',
          colorTextSecondary: '#7d7067',
          colorBorder: '#ead8c8',
          colorBgContainer: 'rgba(255,255,255,0.78)',
          borderRadius: 12,
          fontFamily: '"Microsoft YaHei UI", "PingFang SC", "Noto Sans SC", sans-serif'
        },
        components: {
          Button: { controlHeight: 36, borderRadius: 10 },
          Card: { borderRadiusLG: 16 },
          Table: { headerBg: '#fff8f1', rowHoverBg: '#fff4ea' },
          Input: { controlHeight: 40 },
          Select: { controlHeight: 36 }
        }
      }}
    >
      <AntdApp message={{ maxCount: 1 }}>
        <MessageBinder />
        <BrowserRouter
          basename={basePath === '/' ? undefined : basePath}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <App />
        </BrowserRouter>
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>
);
