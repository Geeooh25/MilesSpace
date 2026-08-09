// frontend/support-widget.js

class SupportWidget {
    constructor(options = {}) {
        this.apiUrl = options.apiUrl || '/api/support';
        this.userId = options.userId;
        this.token = options.token;
        this.conversationId = options.conversationId || null;
        this.isOpen = false;
        this.messages = [];
        this.isAdmin = options.isAdmin || false;
        this.pollingInterval = null;
        
        this.init();
    }

    init() {
        this.createWidget();
        this.loadConversation();
    }

    createWidget() {
        // Widget container
        const container = document.createElement('div');
        container.id = 'support-widget';
        container.innerHTML = `
            <div class="support-widget-button" onclick="supportWidget.toggle()">
                <i class="fas fa-headset"></i>
                <span class="badge" id="unreadBadge" style="display:none;">0</span>
            </div>
            <div class="support-widget-content" id="supportWidgetContent" style="display:none;">
                <div class="support-header">
                    <div class="support-header-left">
                        <i class="fas fa-headset"></i>
                        <div>
                            <h3>Support</h3>
                            <span id="supportStatus">Online</span>
                        </div>
                    </div>
                    <button class="support-close" onclick="supportWidget.close()">✕</button>
                </div>
                <div class="support-body" id="supportMessages"></div>
                <div class="support-footer">
                    <div class="support-typing" id="supportTyping" style="display:none;">
                        <span class="typing-dots">
                            <span>•</span><span>•</span><span>•</span>
                        </span>
                        <span class="typing-text">Admin is typing...</span>
                    </div>
                    <div class="support-input-area">
                        <button class="support-attach" onclick="supportWidget.attachFile()">
                            <i class="fas fa-paperclip"></i>
                            <input type="file" id="supportFileInput" style="display:none;" multiple>
                        </button>
                        <input type="text" id="supportInput" placeholder="Type your message..." 
                               onkeydown="supportWidget.handleKeyDown(event)">
                        <button class="support-send" onclick="supportWidget.sendMessage()">
                            <i class="fas fa-paper-plane"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(container);

        // Add styles
        this.addStyles();
    }

    addStyles() {
        const styles = document.createElement('style');
        styles.textContent = `
            .support-widget-button {
                position: fixed;
                bottom: 24px;
                right: 24px;
                width: 60px;
                height: 60px;
                border-radius: 50%;
                background: linear-gradient(135deg, #f59e0b, #d97706);
                color: white;
                font-size: 28px;
                box-shadow: 0 4px 16px rgba(245, 158, 11, 0.4);
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                transition: transform 0.2s, box-shadow 0.2s;
                z-index: 999;
                border: none;
            }
            .support-widget-button:hover {
                transform: scale(1.05);
                box-shadow: 0 6px 24px rgba(245, 158, 11, 0.5);
            }
            .support-widget-button .badge {
                position: absolute;
                top: -5px;
                right: -5px;
                background: #ef4444;
                color: white;
                font-size: 11px;
                padding: 2px 7px;
                border-radius: 99px;
                min-width: 20px;
                text-align: center;
                font-weight: 700;
            }
            
            .support-widget-content {
                position: fixed;
                bottom: 100px;
                right: 24px;
                width: 380px;
                height: 520px;
                background: white;
                border-radius: 16px;
                box-shadow: 0 8px 40px rgba(0,0,0,0.16);
                display: flex;
                flex-direction: column;
                z-index: 1000;
                overflow: hidden;
                animation: slideUp 0.3s ease;
            }
            
            @keyframes slideUp {
                from { opacity: 0; transform: translateY(20px); }
                to { opacity: 1; transform: translateY(0); }
            }
            
            .support-header {
                padding: 16px 20px;
                background: linear-gradient(135deg, #0c3d4a, #12556a);
                color: white;
                display: flex;
                justify-content: space-between;
                align-items: center;
                flex-shrink: 0;
            }
            .support-header-left {
                display: flex;
                align-items: center;
                gap: 12px;
            }
            .support-header-left i { font-size: 20px; }
            .support-header-left h3 { font-size: 15px; margin: 0; }
            .support-header-left span { font-size: 11px; opacity: 0.8; }
            .support-close {
                background: none;
                border: none;
                color: white;
                font-size: 20px;
                cursor: pointer;
                opacity: 0.7;
                transition: opacity 0.2s;
            }
            .support-close:hover { opacity: 1; }
            
            .support-body {
                flex: 1;
                overflow-y: auto;
                padding: 16px 20px;
                background: #f8fafc;
            }
            
            .support-body .message {
                margin-bottom: 12px;
                max-width: 85%;
                padding: 10px 14px;
                border-radius: 12px;
                animation: messageIn 0.25s ease;
            }
            .support-body .message.user {
                background: #0c3d4a;
                color: white;
                align-self: flex-end;
                margin-left: auto;
                border-bottom-right-radius: 4px;
            }
            .support-body .message.support {
                background: white;
                color: #1a2a33;
                border: 1px solid #e4e8ec;
                align-self: flex-start;
                border-bottom-left-radius: 4px;
            }
            .support-body .message.system {
                background: #f1f3f5;
                color: #5b7480;
                font-size: 12px;
                text-align: center;
                align-self: center;
                max-width: 90%;
                border-radius: 20px;
                padding: 6px 14px;
            }
            
            .support-body .message .time {
                font-size: 10px;
                opacity: 0.6;
                margin-top: 4px;
                text-align: right;
            }
            
            @keyframes messageIn {
                from { opacity: 0; transform: translateY(8px); }
                to { opacity: 1; transform: translateY(0); }
            }
            
            .support-footer {
                border-top: 1px solid #e4e8ec;
                padding: 12px 16px;
                background: white;
                flex-shrink: 0;
            }
            
            .support-typing {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 4px 0 8px;
                color: #5b7480;
                font-size: 12px;
            }
            .typing-dots span {
                display: inline-block;
                animation: typingDot 1.4s infinite;
                font-size: 20px;
                line-height: 1;
                margin: 0 1px;
            }
            .typing-dots span:nth-child(2) { animation-delay: 0.2s; }
            .typing-dots span:nth-child(3) { animation-delay: 0.4s; }
            
            @keyframes typingDot {
                0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
                30% { opacity: 1; transform: translateY(-4px); }
            }
            
            .support-input-area {
                display: flex;
                gap: 10px;
                align-items: center;
            }
            .support-input-area input {
                flex: 1;
                padding: 10px 14px;
                border: 1px solid #e4e8ec;
                border-radius: 10px;
                font-size: 13px;
                outline: none;
                transition: border-color 0.2s;
                background: #f8fafc;
            }
            .support-input-area input:focus {
                border-color: #0c3d4a;
                background: white;
            }
            .support-input-area .support-send {
                width: 40px;
                height: 40px;
                border-radius: 50%;
                background: #0c3d4a;
                color: white;
                border: none;
                cursor: pointer;
                transition: background 0.2s, transform 0.15s;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .support-input-area .support-send:hover {
                background: #12556a;
                transform: scale(1.05);
            }
            .support-input-area .support-send:active {
                transform: scale(0.95);
            }
            .support-input-area .support-attach {
                width: 36px;
                height: 36px;
                border-radius: 50%;
                background: none;
                border: 1px solid #e4e8ec;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                color: #5b7480;
                transition: all 0.2s;
                position: relative;
            }
            .support-input-area .support-attach:hover {
                background: #f8fafc;
                border-color: #0c3d4a;
                color: #0c3d4a;
            }
            
            .support-status-indicator {
                display: inline-block;
                width: 8px;
                height: 8px;
                border-radius: 50%;
                margin-right: 6px;
            }
            .support-status-indicator.online { background: #22c55e; }
            .support-status-indicator.away { background: #f59e0b; }
            .support-status-indicator.offline { background: #ef4444; }
            
            @media(max-width: 480px) {
                .support-widget-content {
                    width: 100%;
                    height: 100vh;
                    bottom: 0;
                    right: 0;
                    border-radius: 0;
                }
                .support-widget-button {
                    bottom: 16px;
                    right: 16px;
                    width: 54px;
                    height: 54px;
                    font-size: 24px;
                }
            }
        `;
        document.head.appendChild(styles);
    }

    async loadConversation() {
        if (this.conversationId) {
            try {
                const response = await fetch(`${this.apiUrl}/conversations/${this.conversationId}`, {
                    headers: {
                        'Authorization': `Bearer ${this.token}`
                    }
                });
                const data = await response.json();
                
                if (data.success) {
                    this.messages = data.data.messages || [];
                    this.renderMessages();
                }
            } catch (error) {
                console.error('Load conversation error:', error);
            }
        }
    }

    async sendMessage() {
        const input = document.getElementById('supportInput');
        const message = input.value.trim();
        
        if (!message) return;

        input.value = '';
        input.disabled = true;
        
        // Add user message to UI
        this.addMessage({
            sender_type: 'user',
            message: message,
            created_at: new Date().toISOString()
        });

        try {
            const response = await fetch(`${this.apiUrl}/ask`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify({
                    message: message,
                    conversation_id: this.conversationId
                })
            });

            const data = await response.json();

            if (data.success) {
                this.conversationId = data.data.conversation_id;
                
                // Add AI/System response
                this.addMessage({
                    sender_type: data.data.response_type === 'system' ? 'system' : 'support',
                    message: data.data.response,
                    created_at: new Date().toISOString()
                });

                // Check if escalation needed
                if (data.data.escalation_needed) {
                    this.showEscalationNotice();
                }

                // Update status
                this.updateStatus(data.data.status);
            } else {
                this.addMessage({
                    sender_type: 'system',
                    message: '❌ ' + (data.error || 'Failed to send message. Please try again.'),
                    created_at: new Date().toISOString()
                });
            }
        } catch (error) {
            console.error('Send message error:', error);
            this.addMessage({
                sender_type: 'system',
                message: '❌ Connection error. Please check your internet and try again.',
                created_at: new Date().toISOString()
            });
        }

        input.disabled = false;
        input.focus();
        this.scrollToBottom();
    }

    addMessage(message) {
        const container = document.getElementById('supportMessages');
        const msgDiv = document.createElement('div');
        msgDiv.className = `message ${message.sender_type}`;
        
        const senderLabels = {
            user: 'You',
            support: 'Support',
            admin: 'Admin',
            system: 'System',
            ai: 'AI Assistant'
        };
        
        const senderLabel = senderLabels[message.sender_type] || message.sender_type;
        const time = new Date(message.created_at).toLocaleTimeString();
        
        // Format message (support markdown-like formatting)
        let formattedMessage = message.message
            .replace(/\n/g, '<br>')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>');
        
        msgDiv.innerHTML = `
            <div style="font-size:11px;font-weight:600;margin-bottom:3px;color:${message.sender_type === 'user' ? 'rgba(255,255,255,0.7)' : '#5b7480'}">
                ${senderLabel}
            </div>
            <div>${formattedMessage}</div>
            <div class="time">${time}</div>
        `;
        
        container.appendChild(msgDiv);
        this.messages.push(message);
        this.scrollToBottom();
    }

    renderMessages() {
        const container = document.getElementById('supportMessages');
        container.innerHTML = '';
        this.messages.forEach(msg => this.addMessage(msg));
    }

    scrollToBottom() {
        const container = document.getElementById('supportMessages');
        container.scrollTop = container.scrollHeight;
    }

    handleKeyDown(event) {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            this.sendMessage();
        }
    }

    attachFile() {
        document.getElementById('supportFileInput').click();
    }

    updateStatus(status) {
        const statusEl = document.getElementById('supportStatus');
        const statusMap = {
            'active': '🟢 Online',
            'ai_handling': '🤖 AI Assistant',
            'waiting_admin': '🟡 Waiting for Agent',
            'admin_handling': '🟢 Agent Online',
            'resolved': '✅ Resolved',
            'closed': '🔴 Closed'
        };
        statusEl.textContent = statusMap[status] || 'Online';
    }

    showEscalationNotice() {
        const statusEl = document.getElementById('supportStatus');
        statusEl.textContent = '🟡 Escalated to Agent';
        statusEl.style.color = '#f59e0b';
    }

    toggle() {
        this.isOpen = !this.isOpen;
        const content = document.getElementById('supportWidgetContent');
        content.style.display = this.isOpen ? 'flex' : 'none';
        
        if (this.isOpen) {
            this.scrollToBottom();
            document.getElementById('supportInput').focus();
            this.startPolling();
        } else {
            this.stopPolling();
        }
    }

    close() {
        this.isOpen = false;
        document.getElementById('supportWidgetContent').style.display = 'none';
        this.stopPolling();
    }

    startPolling() {
        if (this.pollingInterval) return;
        
        this.pollingInterval = setInterval(() => {
            if (this.conversationId) {
                this.checkForNewMessages();
            }
        }, 5000);
    }

    stopPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
    }

    async checkForNewMessages() {
        try {
            const response = await fetch(`${this.apiUrl}/conversations/${this.conversationId}`, {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });
            const data = await response.json();
            
            if (data.success && data.data.messages) {
                const newMessages = data.data.messages.slice(this.messages.length);
                if (newMessages.length > 0) {
                    newMessages.forEach(msg => {
                        if (msg.sender_type !== 'user') {
                            this.addMessage(msg);
                        }
                    });
                    
                    // Update unread badge
                    const unread = newMessages.filter(m => m.sender_type !== 'user' && !m.is_read).length;
                    if (unread > 0 && !this.isOpen) {
                        const badge = document.getElementById('unreadBadge');
                        badge.textContent = unread;
                        badge.style.display = 'block';
                    }
                }
            }
        } catch (error) {
            // Silent fail for polling
        }
    }
}

// Initialize widget
window.supportWidget = new SupportWidget({
    userId: window.userId,
    token: window.token,
    conversationId: window.conversationId,
    isAdmin: false
});