<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, Download, Printer } from '@element-plus/icons-vue'
type ManualSection = [string, string[]]
const route=useRoute(); const router=useRouter(); const lang=computed(()=>route.params.lang==='zh'||route.query.lang==='zh'?'zh':'en')
const en: ManualSection[]=[
  ['Before you begin',['Use only the approved stock Android build. Do not root, unlock the bootloader or enable permanent ADB.','Prepare both SIM ICCIDs, Telebirr numbers, registered names, a stable charger and Wi-Fi/mobile data.']],
  ['Factory reset and MDM',['Factory-reset the phone and stop on the first Welcome screen.','Tap a blank area six times and enroll AirDroid Business as Device Owner using the organization QR code.','Confirm Device Owner/Fully managed before applying the Telebirr-Pilot multi-app kiosk policy.']],
  ['Install workload application',['Install the signed Telebirr Device Agent from the MDM app library.','Never install APKs from chat messages or unofficial download sites.']],
  ['Configure HiOS',['Allow autostart and unrestricted battery use for Telebirr Agent and AirDroid.','Grant Phone, SMS, Notifications and Accessibility permissions to Telebirr Agent.','Disable battery optimization and verify that Accessibility survives a reboot.']],
  ['Activate and secure',['In Telebirr Device Agent type the Device Gateway URL and one-time activation code, then tap Activate.','With remote control stopped, enter and confirm each Telebirr PIN locally. The PIN is encrypted by Android Keystore and never sent to the cloud.']],
  ['Qualify both SIMs',['For each slot, verify ICCID and subscription attribution.','Run SMS receipt, USSD menu, balance query and low-value transfer confirmation tests.','Record every check, reboot and interrupt the network; authorized staff then use Approve with password.']],
  ['Recovery',['Quarantine the device and stop new jobs. Never retry a post-PIN unknown transfer.','Use only exact signed regional firmware obtained through TECNO/Carlcare.','Factory-reset, re-enroll, enter PINs locally and repeat full qualification.']],
]
const zh: ManualSection[]=[
  ['开始之前',['仅使用已批准的原厂 Android 系统。禁止 Root、解锁 Bootloader 或永久开启 ADB。','准备两张 SIM 卡的 ICCID、Telebirr 号码、实名、稳定充电器及网络。']],
  ['恢复出厂设置与 MDM',['恢复出厂设置，并停留在第一个 Welcome 界面。','快速点击空白区域六次，使用企业二维码将 AirDroid Business 注册为 Device Owner。','确认 Device Owner/Fully managed 后再应用 Telebirr-Pilot 多应用 Kiosk 策略。']],
  ['安装工作应用',['从 MDM 应用库安装已签名的 Telebirr Device Agent。','严禁安装聊天消息或非官方网站提供的 APK。']],
  ['配置 HiOS',['允许 Telebirr Agent 与 AirDroid 自启动及无限制电池使用。','向 Telebirr Agent 授予电话、短信、通知及无障碍权限。','关闭电池优化，重启后确认无障碍服务仍然有效。']],
  ['激活与安全',['在 Telebirr Device Agent 中输入 Device Gateway URL 和一次性激活码，然后点击激活。','停止远程控制后，在手机本地输入并确认每张卡的 Telebirr PIN。PIN 由 Android Keystore 加密，绝不上传云端。']],
  ['双卡验收',['逐卡核对 ICCID 与订阅槽位归属。','执行短信接收、USSD 菜单、余额查询及小额转账确认测试。','记录每项检查，完成重启和断网测试；最后由获授权人员点击 Approve with password。']],
  ['故障恢复',['隔离设备并停止分配新任务。PIN 提交后的未知交易绝不能自动重试。','仅使用 TECNO/Carlcare 提供的匹配区域官方签名固件。','恢复出厂设置、重新注册、本地输入 PIN，并重新执行全部验收。']],
]
const sections=computed(()=>lang.value==='zh'?zh:en)
const fieldPdfUrl=computed(()=>lang.value==='zh'?'/manuals/telebirr-field-phone-installation-zh-CN.pdf':'/manuals/telebirr-field-phone-installation-en.pdf')
function changeLanguage(value: string | number | boolean | undefined) { router.replace(`/manuals/phone-installation/${value === 'zh' ? 'zh' : 'en'}`) }
function printManual() { window.print() }
</script>
<template>
  <div class="manual">
    <header class="no-print"><el-button :icon="ArrowLeft" @click="$router.back()">Back</el-button><el-radio-group :model-value="lang" @change="changeLanguage"><el-radio-button value="en">English</el-radio-button><el-radio-button value="zh">简体中文</el-radio-button></el-radio-group><div><el-button tag="a" :href="fieldPdfUrl" target="_blank" type="primary" :icon="Download">Simple setup guide PDF</el-button><el-button :icon="Printer" @click="printManual">Print quick reference</el-button></div></header>
    <article><div class="cover"><div class="mark">T</div><p>TELEBIRR P2P · FLEET OPERATIONS</p><h1>{{lang==='zh'?'Telebirr 手机安装快速参考':'Telebirr Phone Installation Quick Reference'}}</h1><span>{{lang==='zh'?'完整逐步点击说明请下载现场手册 PDF · 版本 1.0':'Download the full field handbook PDF for every click · Version 1.0'}}</span></div>
      <div class="warning">{{lang==='zh'?'安全红线：PIN 仅可在手机本地输入。任何人不得拍照、聊天发送或记录 PIN。':'SECURITY RULE: PINs are entered only on the phone. Never photograph, message, record or upload a PIN.'}}</div>
      <div class="field-note">{{lang==='zh'?'本页是主管快速参考。请把可下载的《简单手机安装指南》交给本地安装人员。':'This page is a supervisor reference. Give the downloadable Simple Phone Setup Guide to the local installer.'}}</div>
      <section v-for="(section,index) in sections" :key="section[0]"><div class="number">{{index+1}}</div><div><h2>{{section[0]}}</h2><ol><li v-for="item in section[1]" :key="item">{{item}}</li></ol></div></section>
      <footer><b>{{lang==='zh'?'验收签字':'Qualification sign-off'}}</b><div><span>{{lang==='zh'?'设备名称':'Device name'}} __________________</span><span>{{lang==='zh'?'技术员':'Technician'}} __________________</span><span>{{lang==='zh'?'日期':'Date'}} __________________</span></div></footer>
    </article>
  </div>
</template>
<style scoped>
.manual{min-height:100vh;background:#eef0f4;padding:25px}.manual>header{max-width:900px;margin:0 auto 15px;display:flex;justify-content:space-between;gap:10px}.manual article{max-width:900px;margin:auto;background:white;padding:60px 70px;box-shadow:0 10px 35px rgba(22,29,44,.08)}.cover{border-bottom:3px solid #5c5ce2;padding-bottom:35px;margin-bottom:25px}.mark{width:42px;height:42px;border-radius:11px;display:grid;place-items:center;background:#5c5ce2;color:#fff;font:800 22px 'Manrope'}.cover p{font-size:10px;letter-spacing:.16em;color:#5c5ce2;font-weight:800;margin-top:18px}.cover h1{font-size:34px;max-width:670px;margin:12px 0}.cover span{font-size:11px;color:#6f7890}.warning{padding:14px 16px;border-left:4px solid #d94c61;background:#fff0f2;color:#a83244;font-size:11px;font-weight:700;margin-bottom:12px}.field-note{padding:14px 16px;background:#eef7ff;color:#285b86;border-left:4px solid #4c8fc7;font-size:11px;font-weight:700;margin-bottom:28px}.manual section{display:grid;grid-template-columns:42px 1fr;gap:18px;margin:24px 0;break-inside:avoid}.number{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:#eeeeff;color:#5c5ce2;font-weight:800}.manual h2{font-size:17px;margin:4px 0 8px}.manual ol{padding-left:18px;margin:0}.manual li{font-size:11px;line-height:1.75;color:#465066;margin:3px 0}.manual footer{border-top:1px solid #e5e9f1;margin-top:35px;padding-top:20px;font-size:11px}.manual footer>div{display:flex;gap:25px;margin-top:25px;color:#6f7890}@media print{.manual{padding:0;background:white}.manual article{box-shadow:none;max-width:none;padding:20mm}.manual>header{display:none}}@media(max-width:700px){.manual{padding:0}.manual article{padding:35px 24px}.manual>header{padding:12px;flex-wrap:wrap}.cover h1{font-size:26px}.manual footer>div{flex-direction:column}}
</style>
