require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static('public'));

const PORT = process.env.PORT || 3001;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID;
const EVERFLOW_API_KEY = process.env.EVERFLOW_API_KEY;
const CLOAKER_LOG_PATH = process.env.CLOAKER_LOG_PATH;
const ZIP_DEBT_URL = 'https://go.zipdebtcheck.com/stats?token=afcfceea8eb90666d6ad3c2f3dde4ff5';

// Internal Cache to handle API Rate Limits / Big Query Limits
let efCache = {
    today: { data: [], timestamp: null },
    yesterday: { data: [], timestamp: null },
    last_7d: { data: [], timestamp: null }
};

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const API_VERSION = 'v19.0';
const FB_BASE_URL = `https://graph.facebook.com/${API_VERSION}`;
const EF_BASE_URL = 'https://api.eflow.team/v1';

// Keep track of alerted entities to avoid spam (Reset on server restart or daily)
const alertedEntities = new Set();

async function sendTelegramAlert(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        });
        console.log('Telegram alert sent:', message);
    } catch (error) {
        console.error('Telegram error:', error.response?.data || error.message);
    }
}

// --- DATA FETCHERS ---

async function getZipDebtStats() {
    try {
        const response = await axios.get(ZIP_DEBT_URL, { timeout: 10000 });
        const html = response.data;

        const extract = (regex) => {
            const match = html.match(regex);
            return match ? match[1].replace(/,/g, '').trim() : "0";
        };

        const totals = {
            visitors: parseInt(extract(/<div class="stat-num"[^>]*>([\d,]+)<\/div>\s*<div class="stat-lbl">Unique Visitors<\/div>/i)),
            bots: parseInt(extract(/<div class="stat-num"[^>]*>([\d,]+)<\/div>\s*<div class="stat-lbl">Bots Blocked<\/div>/i)),
            lander_hits: parseInt(extract(/<div class="funnel-num"[^>]*>([\d,]+)<\/div>\s*<div class="funnel-lbl">Landed on Pre-Lander<\/div>/i)),
            offer_clicks: parseInt(extract(/<div class="funnel-num"[^>]*>([\d,]+)<\/div>\s*<div class="funnel-lbl">Clicked to Offer Page<\/div>/i))
        };

        const dailyBreakdown = [];
        const tableBodyMatch = html.match(/<div class="sec-title">Daily Breakdown<\/div>[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/i);
        if (tableBodyMatch) {
            const tbody = tableBodyMatch[1];
            const rowRegex = /<tr>[\s\S]*?<td class="td-name">([^<]+)<\/td>[\s\S]*?<td class="r[^>]*>([^<]+)<\/td>[\s\S]*?<td class="r[^>]*>([^<]+)<\/td>[\s\S]*?<span class="v-amber"[^>]*>([^<]+)<\/span>/gi;
            let match;
            while ((match = rowRegex.exec(tbody)) !== null) {
                dailyBreakdown.push({
                    date: match[1].trim(),
                    lander_hits: match[2].trim(),
                    offer_clicks: match[3].trim(),
                    pass_through: match[4].trim()
                });
            }
        }
        return { totals, dailyBreakdown };
    } catch (error) {
        return { totals: { visitors: 0, bots: 0, lander_hits: 0, offer_clicks: 0 }, dailyBreakdown: [] };
    }
}

async function getMetaAdBreakdown(datePreset = 'today') {
    try {
        const response = await axios.get(`${FB_BASE_URL}/act_${META_AD_ACCOUNT_ID}/insights`, {
            params: {
                access_token: META_ACCESS_TOKEN,
                level: 'ad',
                fields: 'campaign_name,adset_name,ad_name,adset_id,ad_id,spend,clicks,cpc,ctr,impressions,actions',
                date_preset: datePreset,
                limit: 250
            }
        });
        return response.data.data || [];
    } catch (error) {
        return [];
    }
}

async function getEverflowStats(datePreset = 'today') {
    try {
        const now = new Date();
        const start = new Date(now);
        if (datePreset === 'yesterday') start.setDate(now.getDate() - 1);
        if (datePreset === 'last_7d') start.setDate(now.getDate() - 7);

        const from = start.toISOString().split('T')[0];
        const to = now.toISOString().split('T')[0];

        const response = await axios.post(`${EF_BASE_URL}/affiliates/reporting/entity/table`, {
            from: from,
            to: to,
            timezone_id: 80,
            currency_id: "USD",
            columns: [{ column: "sub1" }],
            metrics: [{ metric: "payout" }]
        }, { headers: { 'X-Eflow-Api-Key': EVERFLOW_API_KEY } });

        // Transform table format to match expected map structure
        const rows = response.data.table || [];
        const transformed = rows.map(row => ({
            sub_id: row.columns[0].id,
            payout: row.reporting.revenue,
            clicks: row.reporting.total_click
        }));

        // Update Cache
        efCache[datePreset] = { data: transformed, timestamp: new Date() };

        return { data: transformed, success: true, cached: false };
    } catch (error) {
        const errorMsg = error.response?.data || error.message;
        console.error('Everflow fetch failed:', errorMsg);

        // Return cached data if available
        if (efCache[datePreset] && efCache[datePreset].data.length > 0) {
            console.log(`Using cached Everflow data for ${datePreset} (Stale)`);
            return { data: efCache[datePreset].data, success: false, error: 'API_LIMIT', cached: true };
        }

        return { data: [], success: false, error: errorMsg };
    }
}

// --- API ENDPOINTS ---

// Vercel Cron Support
app.get('/api/cron-stats', async (req, res) => {
    // Basic protection (could use a secret key)
    await sendHourlyStats();
    res.json({ success: true, message: 'Hourly stats triggered' });
});

app.get('/api/metrics', async (req, res) => {
    const preset = req.query.date_preset || 'today';

    const [metaAds, efResult, zipData] = await Promise.all([
        getMetaAdBreakdown(preset),
        getEverflowStats(preset),
        getZipDebtStats()
    ]);

    const efStats = efResult.data;
    const efSuccess = efResult.success;

    const zipStats = zipData.totals;
    const efMap = {};
    let totalOfferClicks = 0;
    efStats.forEach(row => {
        const clicks = parseInt(row.reporting?.clicks || row.clicks || 0);
        const payout = parseFloat(row.reporting?.payout || row.payout || 0);
        efMap[row.sub_id] = { revenue: payout, clicks: clicks };
        totalOfferClicks += clicks;
    });

    const adsetMap = {};
    metaAds.forEach(ad => {
        const adId = ad.ad_id;
        const adsetId = ad.adset_id;
        const ef = efMap[adId] || { revenue: 0, clicks: 0 };

        const spend = parseFloat(ad.spend || 0);
        const rev = ef.revenue;
        const profit = rev - spend;
        const leads = parseInt(ad.actions?.find(a => a.action_type === 'lead')?.value || 0);

        const adData = {
            id: adId,
            name: ad.ad_name,
            spend: spend,
            revenue: rev,
            profit: profit,
            roi: spend > 0 ? (profit / spend) * 100 : 0,
            leads: leads,
            clicks: parseInt(ad.clicks || 0),
            offer_clicks: ef.clicks
        };

        // RED ALERT Check (Only if Everflow check was successful to avoid false positives)
        if (efSuccess && spend >= 10 && leads === 0 && rev === 0 && !alertedEntities.has(adId)) {
            alertedEntities.add(adId);
            sendTelegramAlert(`🚨 <b>RED ALERT: Underperforming Ad</b>\n\n<b>Ad:</b> ${ad.ad_name}\n<b>Adset:</b> ${ad.adset_name}\n<b>Spend:</b> $${spend.toFixed(2)}\n<b>Leads:</b> 0\n<b>Revenue:</b> $0\n\n<i>Time to cut or adjust!</i>`);
        }

        if (!adsetMap[adsetId]) {
            adsetMap[adsetId] = {
                id: adsetId,
                name: ad.adset_name,
                campaign: ad.campaign_name,
                spend: 0, revenue: 0, profit: 0, leads: 0, clicks: 0, offer_clicks: 0,
                ads: []
            };
        }

        const adset = adsetMap[adsetId];
        adset.spend += adData.spend;
        adset.revenue += adData.revenue;
        adset.profit += adData.profit;
        adset.leads += adData.leads;
        adset.clicks += adData.clicks;
        adset.offer_clicks += adData.offer_clicks;
        adset.ads.push(adData);
    });

    const report = Object.values(adsetMap).map(as => {
        as.roi = as.spend > 0 ? (as.profit / as.spend) * 100 : 0;

        // RED ALERT for Adset
        if (efSuccess && as.spend >= 10 && as.leads === 0 && as.revenue === 0 && !alertedEntities.has(as.id)) {
            alertedEntities.add(as.id);
            sendTelegramAlert(`🚨 <b>RED ALERT: Underperforming Adset</b>\n\n<b>Adset:</b> ${as.name}\n<b>Spend:</b> $${as.spend.toFixed(2)}\n<b>Leads:</b> 0\n<b>Revenue:</b> $0\n\n<i>Review immediately.</i>`);
        }

        return as;
    });

    const totalSpend = report.reduce((s, as) => s + as.spend, 0);
    const totalRev = report.reduce((s, as) => s + as.revenue, 0);
    const totalProfit = totalRev - totalSpend;
    const totalLanderHits = zipStats.lander_hits;
    const prelanderCVR = totalLanderHits > 0 ? (totalOfferClicks / totalLanderHits) * 100 : 0;
    const trafficHealth = (totalLanderHits + zipStats.bots) > 0 ? (totalLanderHits / (totalLanderHits + zipStats.bots)) * 100 : 0;

    res.json({
        period: preset,
        totals: {
            profit: totalProfit.toFixed(2),
            spend: totalSpend.toFixed(2),
            revenue: totalRev.toFixed(2),
            roi: totalSpend > 0 ? ((totalProfit / totalSpend) * 100).toFixed(0) : 0,
            prelander_clicks: totalLanderHits,
            offer_clicks: totalOfferClicks,
            prelander_cvr: prelanderCVR.toFixed(2),
            unique_visitors: zipStats.visitors,
            bots_blocked: zipStats.bots,
            pass_rate: trafficHealth.toFixed(0)
        },
        adsets: report,
        daily_breakdown: zipData.dailyBreakdown
    });
});

const { Telegraf, Markup } = require('telegraf');
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

const LEADS_FILE = path.join(__dirname, '../telegram-outreach-agent/leads.json');
const OUTBOX_FILE = path.join(__dirname, '../telegram-outreach-agent/outbox.json');
const PROSPECTS_FILE = path.join(__dirname, '../linkedin-outreach-agent/prospects.json');
const LI_OUTBOX_FILE = path.join(__dirname, '../linkedin-outreach-agent/li_outbox.json');

// --- BOT COMMANDS ---

bot.start((ctx) => {
    ctx.reply('🚀 <b>AG War Room Bot</b>\nSelect an option:', {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('📊 Daily Stats', 'get_stats')],
            [Markup.button.callback('🏹 View Leads (TG)', 'view_leads')],
            [Markup.button.callback('👔 View Prospects (LI)', 'view_prospects')],
            [Markup.button.callback('🔍 Hunt Group', 'start_hunt')]
        ])
    });
});

bot.action('get_stats', async (ctx) => {
    const { totals } = await getZipDebtStats();
    const meta = await getMetaAdBreakdown();
    const spend = meta.reduce((acc, ad) => acc + parseFloat(ad.spend || 0), 0).toFixed(2);

    ctx.reply(`📊 <b>Today\'s Pulse</b>\n\n💰 <b>Spend</b>: $${spend}\n👤 <b>Visitors</b>: ${totals.visitors}\n✅ <b>Pass-through</b>: ${totals.lander_hits}\n🎯 <b>Offer Clicks</b>: ${totals.offer_clicks}`, { parse_mode: 'HTML' });
});

bot.action('view_leads', (ctx) => {
    try {
        if (!fs.existsSync(LEADS_FILE)) return ctx.reply('No leads found yet.');
        const leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
        const pending = leads.filter(l => l.status === 'pending');

        if (pending.length === 0) return ctx.reply('✅ No pending leads.');

        const lead = pending[0];
        ctx.reply(`🏹 <b>New Prospect</b>\n👤 <b>Name</b>: ${lead.name}\n💬 <b>Msg</b>: "${lead.message.slice(0, 50)}..."\n\n<b>AI Pitch</b>:\n<i>${lead.suggested_pitch}</i>`, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ Send Pitch', `send_${lead.user_id}`)],
                [Markup.button.callback('❌ Reject', `reject_${lead.user_id}`)]
            ])
        });
    } catch (e) {
        ctx.reply('Error reading leads.');
    }
});

bot.action('view_prospects', (ctx) => {
    try {
        if (!fs.existsSync(PROSPECTS_FILE)) return ctx.reply('No LinkedIn prospects found.');
        const prospects = JSON.parse(fs.readFileSync(PROSPECTS_FILE, 'utf8'));
        const pending = prospects.filter(p => p.status === 'scouted');

        if (pending.length === 0) return ctx.reply('✅ No pending prospects.');

        const person = pending[0];
        // Use a default Super Affiliate note
        const note = `Hi ${person.name.split(' ')[0]}, saw your team is scaling in the debt space. I'm a super affiliate ($12M spend) generating high-intent in-house leads. Let's connect.`;

        ctx.reply(`👔 <b>LinkedIn Prospect</b>\n👤 <b>Name</b>: ${person.name}\n💼 <b>Title</b>: ${person.title}\n\n<b>Draft Note</b>:\n<i>${note}</i>`, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ Approve Invite', `li_send_${Buffer.from(person.profile_url).toString('base64')}`)],
                [Markup.button.callback('❌ Reject', `li_reject_${Buffer.from(person.profile_url).toString('base64')}`)]
            ])
        });
    } catch (e) {
        ctx.reply('Error reading prospects.');
    }
});

// Handle LinkedIn Send/Reject actions
bot.action(/^(li_send|li_reject)_(.+)$/, (ctx) => {
    const action = ctx.match[1];
    const profileUrl = Buffer.from(ctx.match[2], 'base64').toString('ascii');

    try {
        let prospects = JSON.parse(fs.readFileSync(PROSPECTS_FILE, 'utf8'));
        const pIndex = prospects.findIndex(p => p.profile_url === profileUrl);

        if (pIndex === -1) return ctx.answerCbQuery('Prospect not found.');

        if (action === 'li_send') {
            let outbox = [];
            if (fs.existsSync(LI_OUTBOX_FILE)) outbox = JSON.parse(fs.readFileSync(LI_OUTBOX_FILE, 'utf8'));

            const note = `Hi ${prospects[pIndex].name.split(' ')[0]}, saw your team is scaling in the debt space. I'm a super affiliate ($12M spend) generating high-intent in-house leads. Let's connect.`;

            outbox.push({
                name: prospects[pIndex].name,
                profile_url: profileUrl,
                note: note
            });
            fs.writeFileSync(LI_OUTBOX_FILE, JSON.stringify(outbox, null, 4));

            prospects[pIndex].status = 'invited';
            ctx.editMessageText(`✅ Connection request queued for <b>${prospects[pIndex].name}</b>`, { parse_mode: 'HTML' });
        } else {
            prospects[pIndex].status = 'rejected';
            ctx.editMessageText(`❌ Prospect <b>${prospects[pIndex].name}</b> rejected.`, { parse_mode: 'HTML' });
        }

        fs.writeFileSync(PROSPECTS_FILE, JSON.stringify(prospects, null, 4));
    } catch (e) {
        ctx.answerCbQuery('Error processing LinkedIn action.');
    }
});

// Handle Send/Reject actions
bot.action(/^(send|reject)_(.+)$/, (ctx) => {
    const action = ctx.match[1];
    const userId = ctx.match[2];

    try {
        let leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
        const leadIndex = leads.findIndex(l => l.user_id.toString() === userId);

        if (leadIndex === -1) return ctx.answerCbQuery('Lead not found.');

        if (action === 'send') {
            // Add to outbox for agent.py to pick up
            let outbox = [];
            if (fs.existsSync(OUTBOX_FILE)) outbox = JSON.parse(fs.readFileSync(OUTBOX_FILE, 'utf8'));
            outbox.push({ user_id: userId, message: leads[leadIndex].suggested_pitch });
            fs.writeFileSync(OUTBOX_FILE, JSON.stringify(outbox, null, 4));

            leads[leadIndex].status = 'sent';
            ctx.editMessageText(`✅ Pitch sent to <b>${leads[leadIndex].name}</b>`, { parse_mode: 'HTML' });
        } else {
            leads[leadIndex].status = 'rejected';
            ctx.editMessageText(`❌ Lead from <b>${leads[leadIndex].name}</b> rejected.`, { parse_mode: 'HTML' });
        }

        fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 4));
    } catch (e) {
        ctx.answerCbQuery('Error processing action.');
    }
});

// Hourly Stats Alert
async function sendHourlyStats() {
    try {
        const [metaAds, efResult] = await Promise.all([
            getMetaAdBreakdown('today'),
            getEverflowStats('today')
        ]);

        const efStats = efResult.data;
        let totalRev = 0;
        efStats.forEach(row => totalRev += parseFloat(row.payout || 0));

        let totalSpend = 0;
        metaAds.forEach(ad => totalSpend += parseFloat(ad.spend || 0));

        const profit = totalRev - totalSpend;
        const roi = totalSpend > 0 ? ((profit / totalSpend) * 100).toFixed(0) : 0;

        const message = `🔔 <b>Hourly War Room Update</b> 🔔\n\n` +
            `💰 <b>Revenue:</b> $${totalRev.toFixed(2)}\n` +
            `📉 <b>Spend:</b> $${totalSpend.toFixed(2)}\n` +
            `💸 <b>Net Profit:</b> $${profit.toFixed(2)}\n` +
            `📈 <b>ROI:</b> ${roi}%\n\n` +
            `<i>Next update in 60 mins.</i>`;

        await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'HTML' });
        console.log('Hourly stats sent to Telegram.');
    } catch (err) {
        console.error('Failed to send hourly stats:', err.message);
    }
}

// Enable bot and alerts only if NOT on Vercel
if (!process.env.VERCEL) {
    bot.launch().catch(err => console.error('Bot launch failed:', err));
    setInterval(sendHourlyStats, 3600000); // 1 hour
    console.log('Hourly alerts scheduled.');
}

app.listen(PORT, () => {
    console.log(`Unified futuristic tracker on port ${PORT}`);
});
