import { supabase } from './supabase'
import { RealtimeChannel } from '@supabase/supabase-js'

export interface MessageAttachment {
  id: string;
  message_id: string;
  filename: string;
  filepath: string;
  type: string;
  size: number;
  created_at: string;
}

export interface Message {
  id: string
  created_at: string
  sender_id: string
  receiver_id: string
  content: string
  read: boolean
  attachments?: MessageAttachment[]
  sender: {
    username: string
    full_name: string | null
    avatar_url: string | null
  }
}

export interface UserStatus {
  id: string
  username: string
  full_name?: string | null
  avatar_url: string | null
  last_seen: string
  is_online: boolean
}

export async function sendMessage(receiverId: string, content: string, attachments?: File[]) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  // Start a transaction
  const { data: message, error: messageError } = await supabase
    .from('messages')
    .insert({
      sender_id: user.id,
      receiver_id: receiverId,
      content,
      read: false
    })
    .select(`
      *,
      sender:profiles!sender_id (
        username,
        full_name,
        avatar_url
      )
    `)
    .single()

  if (messageError) throw messageError

  // If there are attachments, upload them
  if (attachments && attachments.length > 0) {
    const attachmentPromises = attachments.map(async (file) => {
      // Upload file to storage
      const fileExt = file.name.split('.').pop()
      const fileName = `${Math.random().toString(36).substring(2)}.${fileExt}`
      const filePath = `message-attachments/${message.id}/${fileName}`

      const { error: uploadError } = await supabase.storage
        .from('message-attachments')
        .upload(filePath, file)

      if (uploadError) throw uploadError

      // Create attachment record
      const { error: attachmentError } = await supabase
        .from('message_attachments')
        .insert({
          message_id: message.id,
          filename: file.name,
          filepath: filePath,
          type: file.type,
          size: file.size
        })

      if (attachmentError) throw attachmentError
    })

    await Promise.all(attachmentPromises)
  }

  // Fetch the complete message with attachments
  const { data: completeMessage, error: fetchError } = await supabase
    .from('messages')
    .select(`
      *,
      sender:profiles!sender_id (
        username,
        full_name,
        avatar_url
      ),
      attachments:message_attachments(*)
    `)
    .eq('id', message.id)
    .single()

  if (fetchError) throw fetchError
  return completeMessage as Message
}

export async function getMessages(userId: string) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data, error } = await supabase
    .from('messages')
    .select(`
      *,
      sender:profiles!sender_id (
        username,
        full_name,
        avatar_url
      ),
      attachments:message_attachments(*)
    `)
    .or(`sender_id.eq.${user.id},receiver_id.eq.${user.id}`)
    .order('created_at', { ascending: true })

  if (error) throw error
  return data as Message[]
}

export async function markMessageAsRead(messageId: string) {
  const { error } = await supabase
    .from('messages')
    .update({ read: true })
    .eq('id', messageId)

  if (error) throw error
}

export async function getUserStatus(userId: string): Promise<UserStatus | null> {
  if (!userId || userId === 'undefined' || userId === 'null') {
    console.warn('getUserStatus called with invalid userId:', userId);
    return null;
  }
  
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, username, full_name, avatar_url, last_seen, is_online')
      .eq('id', userId)
      .single()

    if (error) {
      console.error('Error fetching user status:', error);
      // If user not found, return null instead of throwing
      if (error.code === 'PGRST116') {
        return null;
      }
      throw error;
    }
    
    return {
      id: data.id,
      username: data.username || data.full_name || 'Unknown User',
      full_name: data.full_name,
      avatar_url: data.avatar_url,
      last_seen: data.last_seen || new Date().toISOString(),
      is_online: data.is_online || false
    };
  } catch (error) {
    console.error('Error in getUserStatus:', error);
    return null;
  }
}

export async function updateUserStatus(isOnline: boolean) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { error } = await supabase
    .from('profiles')
    .update({
      is_online: isOnline,
      last_seen: new Date().toISOString()
    })
    .eq('id', user.id)

  if (error) throw error
}

export async function getProfileById(userId: string) {
    const { data, error } = await supabase
        .from('profiles')
        .select('id, username, full_name, avatar_url')
        .eq('id', userId)
        .single();
    if (error) throw error;
    return data;
}

let sharedChannel: RealtimeChannel | null = null;
let messageCallbacks: ((message: any) => void)[] = [];
let isSubscribing = false;
let retryTimeout: NodeJS.Timeout | null = null;

export function subscribeToMessages(callback: (message: any) => void) {
    // Add callback to the list
    messageCallbacks.push(callback);

    // If channel doesn't exist or is closed and we're not already subscribing, create it
    if ((!sharedChannel || sharedChannel.state === 'closed') && !isSubscribing) {
        // Reset channel if it's in a closed state
        if (sharedChannel && sharedChannel.state === 'closed') {
            sharedChannel = null;
        }
        isSubscribing = true;
        try {
            sharedChannel = supabase
                .channel('messages')
                .on(
                    'postgres_changes',
                    {
                        event: 'INSERT',
                        schema: 'public',
                        table: 'messages'
                    },
                    (payload) => {
                        // Notify all callbacks
                        messageCallbacks.forEach(cb => {
                            try {
                                cb(payload.new);
                            } catch (err) {
                                console.error('Error in message callback:', err);
                            }
                        });
                    }
                )
                .subscribe((status) => {
                    isSubscribing = false;
                    if (status === 'SUBSCRIBED') {
                        console.log('Successfully subscribed to messages channel');
                        // Clear any retry timeout since we're successfully connected
                        if (retryTimeout) {
                            clearTimeout(retryTimeout);
                            retryTimeout = null;
                        }
                    } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
                        console.warn('Messages channel closed or errored:', status);
                        // Reset channel state so it can be recreated
                        sharedChannel = null;
                        isSubscribing = false;
                        
                        // Retry subscription after a delay if there are still callbacks
                        if (messageCallbacks.length > 0 && !retryTimeout) {
                            retryTimeout = setTimeout(() => {
                                retryTimeout = null;
                                // Force recreation of channel on next subscription attempt
                                sharedChannel = null;
                                isSubscribing = false;
                            }, 5000); // Retry after 5 seconds
                        }
                    } else {
                        console.error('Failed to subscribe to messages channel:', status);
                    }
                });
        } catch (err) {
            isSubscribing = false;
            console.error('Error setting up message subscription:', err);
            throw err;
        }
    }

    // Return unsubscribe function
    return {
        unsubscribe: () => {
            // Remove this callback
            messageCallbacks = messageCallbacks.filter(cb => cb !== callback);
            
            // If no more callbacks, unsubscribe from channel
            if (messageCallbacks.length === 0 && sharedChannel) {
                try {
                    // Check if channel is still active before unsubscribing
                    if (sharedChannel && (sharedChannel.state === 'joined' || sharedChannel.state === 'joining')) {
                        sharedChannel.unsubscribe();
                    }
                    sharedChannel = null;
                } catch (err) {
                    console.error('Error unsubscribing from channel:', err);
                    // Reset channel state even if unsubscribe fails
                    sharedChannel = null;
                }
                
                // Clear retry timeout since no one is listening anymore
                if (retryTimeout) {
                    clearTimeout(retryTimeout);
                    retryTimeout = null;
                }
            }
        }
    };
}

// Subscribe to user status changes
export function subscribeToUserStatus(userId: string, callback: (status: UserStatus) => void) {
  return supabase
    .channel(`user-status-${userId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'profiles',
        filter: `id=eq.${userId}`
      },
      (payload) => {
        callback(payload.new as UserStatus)
      }
    )
    .subscribe()
}

// Handle user presence
export function handleUserPresence() {
  updateUserStatus(true)

  // Update status when user leaves/closes the page
  window.addEventListener('beforeunload', () => {
    updateUserStatus(false)
  })

  // Update status periodically to maintain online presence
  const interval = setInterval(() => {
    updateUserStatus(true)
  }, 60000) // Every minute

  return () => {
    clearInterval(interval)
    updateUserStatus(false)
  }
} 