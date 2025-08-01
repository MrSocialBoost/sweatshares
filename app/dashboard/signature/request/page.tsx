'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import type { Database } from '@/lib/database.types';
import { createSignatureRequest } from '@/lib/signatures';
import {
  ArrowLeft, 
  Plus, 
  Trash2, 
  FileText, 
  Users, 
  Calendar,
  Send,
  Eye,
  MousePointer,
  Type,
  CheckSquare,
  Search,
  Signature
} from 'lucide-react';

interface SignatureBox {
  id: string;
  pageNumber: number;
  x: number; // PDF coordinates
  y: number; // PDF coordinates
  width: number; // PDF coordinates
  height: number; // PDF coordinates
  fieldType: 'signature';
  fieldLabel: string;
  required: boolean;
  isSelected?: boolean;
}

interface Connection {
  id: string;
  full_name: string | null;
  username: string;
  avatar_url: string | null;
  professional_role: string | null;
}

export default function SignatureRequestPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createClientComponentClient<Database>();
  
  const [user, setUser] = useState<any>(null);
  const [document, setDocument] = useState<any>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [selectedReceiver, setSelectedReceiver] = useState<string>('');
  const [message, setMessage] = useState('');
  const [expiresIn, setExpiresIn] = useState('7');
  const [signatureBoxes, setSignatureBoxes] = useState<SignatureBox[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [pdfUrl, setPdfUrl] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [fieldLabel, setFieldLabel] = useState('Signature');
  const [isRequired, setIsRequired] = useState(true);
  const [recipientSearch, setRecipientSearch] = useState('');
  const [selectedBoxId, setSelectedBoxId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [isMounted, setIsMounted] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1.0);
  const [isResizing, setIsResizing] = useState(false);
  const [resizeHandle, setResizeHandle] = useState<'nw' | 'ne' | 'sw' | 'se' | null>(null);
  const [resizeStart, setResizeStart] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const [hoveredHandle, setHoveredHandle] = useState<'nw' | 'ne' | 'sw' | 'se' | null>(null);
  const [baseScale, setBaseScale] = useState(1.5);
  const [originalPdfDimensions, setOriginalPdfDimensions] = useState<{ width: number; height: number } | null>(null);
  
  const pdfContainerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mountedRef = useRef(false);

  const documentId = searchParams.get('documentId');

  // Store drag/resize state in canvas coordinates for accuracy
  const [dragStart, setDragStart] = useState<{ mouseX: number; mouseY: number; boxX: number; boxY: number } | null>(null);
  const [resizeStartCanvas, setResizeStartCanvas] = useState<{ mouseX: number; mouseY: number; boxX: number; boxY: number; boxWidth: number; boxHeight: number } | null>(null);

  // Set mounted state
  useEffect(() => {
    setIsMounted(true);
    mountedRef.current = true;
  }, []);

  // Fetch user and document data
  useEffect(() => {
    const fetchData = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      setUser(user);

      if (user && documentId) {
        // Fetch document
        const { data: doc } = await supabase
        .from('vault_documents')
        .select('*')
        .eq('id', documentId)
          .eq('owner_id', user.id)
          .single();

        if (doc) {
          setDocument(doc);
          // Get PDF URL
          const { data: { publicUrl } } = supabase.storage
            .from('vault')
            .getPublicUrl(doc.filepath);
          setPdfUrl(publicUrl);
        }

        // Fetch connections
        const { data: acceptedConnections } = await supabase
        .from('connections')
        .select(`
          *,
          sender:sender_id(id, full_name, avatar_url),
          receiver:receiver_id(id, full_name, avatar_url)
        `)
        .eq('status', 'accepted')
          .or(`sender_id.eq.${user.id},receiver_id.eq.${user.id}`);

        if (acceptedConnections) {
          const connectionsList = acceptedConnections.map((connection) => {
            const otherUser = connection.sender_id === user.id ? connection.receiver : connection.sender;
            return {
              id: otherUser?.id || '',
              full_name: otherUser?.full_name || null,
              username: otherUser?.full_name || '',
              avatar_url: otherUser?.avatar_url || null,
              professional_role: null
            };
          }).filter(conn => conn.id);
          
          setConnections(connectionsList);
        }
      }
      setIsLoading(false);
    };

    fetchData();
  }, [documentId, supabase]);

  // Load PDF and render to canvas
  useEffect(() => {
    if (!pdfUrl || !mountedRef.current || typeof window === 'undefined') return;

    const loadPDF = async () => {
      try {
        const pdfjsLib = await import('pdfjs-dist');
        pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js';

        const loadingTask = pdfjsLib.getDocument({ url: pdfUrl });
        const pdf = await loadingTask.promise;
        setTotalPages(pdf.numPages);

        // Render first page
        await renderPage(pdf, 1);
      } catch (error) {
        console.error('Error loading PDF:', error);
        toast.error('Failed to load PDF');
      }
    };

    // Add a small delay to ensure everything is ready
    const timer = setTimeout(() => {
      loadPDF();
    }, 100);

    return () => clearTimeout(timer);
  }, [pdfUrl]);

  const renderPage = async (pdf: any, pageNum: number) => {
    if (!canvasRef.current || !mountedRef.current || !pdfContainerRef.current) return;

    try {
      const page = await pdf.getPage(pageNum);
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d');
      const container = pdfContainerRef.current;

      if (!context) {
        console.error('Could not get canvas context');
        return;
      }

      // Get container dimensions
      const containerWidth = container.clientWidth - 32; // Account for padding
      const containerHeight = 600; // Max height from CSS

      // Get original page dimensions
      const originalViewport = page.getViewport({ scale: 1.0 });
      const originalWidth = originalViewport.width;
      const originalHeight = originalViewport.height;

      // Store original PDF dimensions for coordinate conversion
      setOriginalPdfDimensions({ width: originalWidth, height: originalHeight });

      // Calculate scale to fit within container while maintaining aspect ratio
      const scaleX = containerWidth / originalWidth;
      const scaleY = containerHeight / originalHeight;
      const calculatedBaseScale = Math.min(scaleX, scaleY, 2.0); // Cap at 2.0x for readability
      const scale = calculatedBaseScale * zoomLevel; // Apply zoom level

      // Store the base scale for coordinate conversion
      setBaseScale(calculatedBaseScale);

      // Create viewport with calculated scale
      const viewport = page.getViewport({ scale });
      
      // Set canvas dimensions
      canvas.height = viewport.height;
      canvas.width = viewport.width;

      const renderContext = {
        canvasContext: context,
        viewport: viewport
      };

      await page.render(renderContext).promise;
    } catch (error) {
      console.error('Error rendering PDF page:', error);
    }
  };

  const handleZoomChange = async (newZoom: number) => {
    if (newZoom < 0.5 || newZoom > 3.0) return; // Limit zoom range
    setZoomLevel(newZoom);
    
    // Re-render current page with new zoom
    if (pdfUrl && currentPage) {
      try {
        const pdfjsLib = await import('pdfjs-dist');
        const loadingTask = pdfjsLib.getDocument(pdfUrl);
        const pdf = await loadingTask.promise;
        await renderPage(pdf, currentPage);
      } catch (error) {
        console.error('Error re-rendering PDF with zoom:', error);
      }
    }
  };

  // Function to convert viewer coordinates to PDF coordinates
  const convertViewerToPdfCoordinates = (viewerX: number, viewerY: number, viewerWidth: number, viewerHeight: number) => {
    const currentScale = baseScale * zoomLevel;
    
    // Get the canvas and container to calculate the offset
    const canvas = canvasRef.current;
    const container = pdfContainerRef.current;
    
    if (!canvas || !container) {
      return { x: viewerX / currentScale, y: viewerY / currentScale, width: viewerWidth / currentScale, height: viewerHeight / currentScale };
    }
    
    // Calculate the offset between container and canvas
    const containerRect = container.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    
    // The canvas is centered in the container, so we need to adjust for this offset
    const canvasOffsetX = canvasRect.left - containerRect.left;
    const canvasOffsetY = canvasRect.top - containerRect.top;
    
    // Adjust viewer coordinates to be relative to the canvas
    const canvasRelativeX = viewerX - canvasOffsetX;
    const canvasRelativeY = viewerY - canvasOffsetY;
    
    // Convert canvas-relative coordinates to PDF coordinates
    const pdfX = canvasRelativeX / currentScale;
    const pdfWidth = viewerWidth / currentScale;
    const pdfHeight = viewerHeight / currentScale;
    
    // Flip Y coordinate
    const canvasHeightPx = canvas.height;
    const pdfY = canvasHeightPx / currentScale - canvasRelativeY / currentScale - pdfHeight;
    
    return { x: pdfX, y: pdfY, width: pdfWidth, height: pdfHeight };
  };

  // Function to convert PDF coordinates to viewer coordinates for display
  const convertPdfToViewerCoordinates = (pdfX: number, pdfY: number, pdfWidth: number, pdfHeight: number) => {
    const currentScale = baseScale * zoomLevel;
    
    // Get the canvas and container to calculate the offset
    const canvas = canvasRef.current;
    const container = pdfContainerRef.current;
    
    if (!canvas || !container) {
      return { x: pdfX * currentScale, y: pdfY * currentScale, width: pdfWidth * currentScale, height: pdfHeight * currentScale };
    }
    
    // Calculate the offset between container and canvas
    const containerRect = container.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    
    // The canvas is centered in the container, so we need to adjust for this offset
    const canvasOffsetX = canvasRect.left - containerRect.left;
    const canvasOffsetY = canvasRect.top - containerRect.top;
    
    // Convert PDF coordinates to canvas coordinates
    const canvasX = pdfX * currentScale;
    const canvasWidth = pdfWidth * currentScale;
    const canvasHeight = pdfHeight * currentScale;
    
    // Flip Y coordinate back
    const canvasHeightPx = canvas.height;
    const canvasY = canvasHeightPx - (pdfY + pdfHeight) * currentScale;
    
    // Convert to viewer coordinates (relative to container)
    const viewerX = canvasX + canvasOffsetX;
    const viewerY = canvasY + canvasOffsetY;
    
    return { x: viewerX, y: viewerY, width: canvasWidth, height: canvasHeight };
  };

  const handlePageChange = async (newPage: number) => {
    if (newPage < 1 || newPage > totalPages || !mountedRef.current) return;
    
    try {
      const pdfjsLib = await import('pdfjs-dist');
      const loadingTask = pdfjsLib.getDocument(pdfUrl);
      const pdf = await loadingTask.promise;
      
      await renderPage(pdf, newPage);
      setCurrentPage(newPage);
    } catch (error) {
      console.error('Error changing page:', error);
    }
  };

  const handleCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current || !mountedRef.current || isDragging || isResizing) return;

    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    // Check if clicking on an existing box
    const clickedBox = signatureBoxes
      .filter(box => box.pageNumber === currentPage)
      .find(box => 
        x >= box.x && x <= box.x + box.width &&
        y >= box.y && y <= box.y + box.height
      );

    if (clickedBox) {
      // Select the box
      setSelectedBoxId(clickedBox.id);
      return;
    }

    // Check if there's already a signature box on this page
    const existingBoxOnPage = signatureBoxes.find(box => box.pageNumber === currentPage);
    if (existingBoxOnPage) {
      toast.error('Only one signature per page is allowed');
      return;
    }

    // Deselect if clicking on empty space
    setSelectedBoxId(null);

    // Add new box
    const viewerX = x - 150; // Center the box on click
    const viewerY = y - 100; // Center the box on click
    const viewerWidth = 300; // Width for signature and metadata
    const viewerHeight = 150; // Reduced height for better signature/metadata ratio
    
    // Convert to PDF coordinates
    const pdfCoords = convertViewerToPdfCoordinates(viewerX, viewerY, viewerWidth, viewerHeight);
    
    const newBox: SignatureBox = {
      id: `box_${Date.now()}_${Math.random()}`,
      pageNumber: currentPage,
      x: pdfCoords.x,
      y: pdfCoords.y,
      width: pdfCoords.width,
      height: pdfCoords.height,
      fieldType: 'signature',
      fieldLabel: fieldLabel || 'Signature',
      required: isRequired,
      isSelected: true
    };

    setSignatureBoxes(prev => {
      const updated = prev.map(box => ({ ...box, isSelected: false }));
      return [...updated, newBox];
    });
    setSelectedBoxId(newBox.id);
    toast.success('Signature box added');
  };

  const removeSignatureBox = (boxId: string) => {
    setSignatureBoxes(prev => prev.filter(box => box.id !== boxId));
    if (selectedBoxId === boxId) {
      setSelectedBoxId(null);
    }
  };

  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!canvasRef.current || !mountedRef.current) return;

    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const currentPageBoxes = signatureBoxes.filter(box => box.pageNumber === currentPage);
    
    // Check if clicking on a box
    const clickedBox = currentPageBoxes.find(box => 
      x >= box.x && x <= box.x + box.width &&
      y >= box.y && y <= box.y + box.height
    );

    if (clickedBox) {
      setSelectedBoxId(clickedBox.id);
      
      // Check if clicking near corners (exclude corner areas from dragging)
      const cornerSize = 20; // Size of corner area to exclude from dragging
      const isNearCorner = 
        (x <= clickedBox.x + cornerSize && y <= clickedBox.y + cornerSize) || // top-left
        (x >= clickedBox.x + clickedBox.width - cornerSize && y <= clickedBox.y + cornerSize) || // top-right
        (x <= clickedBox.x + cornerSize && y >= clickedBox.y + clickedBox.height - cornerSize) || // bottom-left
        (x >= clickedBox.x + clickedBox.width - cornerSize && y >= clickedBox.y + clickedBox.height - cornerSize); // bottom-right
      
      if (!isNearCorner) {
        // If not near corners, then it's dragging
        setIsDragging(true);
        setDragOffset({ x: x - clickedBox.x, y: y - clickedBox.y });
      }
    }
  };

  // Direct drag handler for signature boxes
  const handleBoxDragStart = (boxId: string) => (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const box = signatureBoxes.find(b => b.id === boxId);
    if (!box || !canvasRef.current) return;
    setSelectedBoxId(boxId);
    setIsDragging(true);
    // Mouse position relative to canvas
    const canvasRect = canvasRef.current.getBoundingClientRect();
    const mouseX = event.clientX - canvasRect.left;
    const mouseY = event.clientY - canvasRect.top;
    // Box position in canvas coordinates
    const { x: boxX, y: boxY } = convertPdfToViewerCoordinates(box.x, box.y, 0, 0);
    setDragStart({ mouseX, mouseY, boxX, boxY });
  };

  // Separate handler for resize handles
  const handleResizeStart = (handle: 'nw' | 'ne' | 'sw' | 'se', boxId: string) => (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const box = signatureBoxes.find(b => b.id === boxId);
    if (!box || !canvasRef.current) return;
    setSelectedBoxId(boxId);
    setIsResizing(true);
    setResizeHandle(handle);
    // Mouse position relative to canvas
    const canvasRect = canvasRef.current.getBoundingClientRect();
    const mouseX = event.clientX - canvasRect.left;
    const mouseY = event.clientY - canvasRect.top;
    // Box position in canvas coordinates
    const { x: boxX, y: boxY, width: boxWidth, height: boxHeight } = convertPdfToViewerCoordinates(box.x, box.y, box.width, box.height);
    setResizeStartCanvas({ mouseX, mouseY, boxX, boxY, boxWidth, boxHeight });
    setResizeStart({ x: box.x, y: box.y, width: box.width, height: box.height });
  };

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!canvasRef.current || !mountedRef.current) return;
    const canvasRect = canvasRef.current.getBoundingClientRect();
    const mouseX = event.clientX - canvasRect.left;
    const mouseY = event.clientY - canvasRect.top;
    if (!isDragging && !isResizing) return;
    setSignatureBoxes(prev => prev.map(box => {
      if (box.id !== selectedBoxId) return box;
      if (isDragging && dragStart) {
        // Move box by mouse delta in canvas coordinates
        const dx = mouseX - dragStart.mouseX;
        const dy = mouseY - dragStart.mouseY;
        // New box position in canvas coordinates
        let newCanvasX = dragStart.boxX + dx;
        let newCanvasY = dragStart.boxY + dy;
        // Snap to pixel grid
        newCanvasX = Math.round(newCanvasX);
        newCanvasY = Math.round(newCanvasY);
        // Convert to PDF coordinates
        const pdfCoords = convertViewerToPdfCoordinates(newCanvasX, newCanvasY, box.width * baseScale * zoomLevel, box.height * baseScale * zoomLevel);
        // Constrain to PDF bounds
        const canvas = canvasRef.current;
        const pdfWidth = canvas ? canvas.width / (baseScale * zoomLevel) : 0;
        const pdfHeight = canvas ? canvas.height / (baseScale * zoomLevel) : 0;
        let newX = Math.max(0, Math.min(pdfCoords.x, pdfWidth - box.width));
        let newY = Math.max(0, Math.min(pdfCoords.y, pdfHeight - box.height));
        return { ...box, x: newX, y: newY };
      }
      if (isResizing && resizeHandle && resizeStartCanvas) {
        const METADATA_HEIGHT = 60 / (baseScale * zoomLevel);
        const MIN_SIGNATURE_HEIGHT = 50 / (baseScale * zoomLevel);
        const minBoxHeight = METADATA_HEIGHT + MIN_SIGNATURE_HEIGHT;
        const minBoxWidth = 50 / (baseScale * zoomLevel);
        let { boxX, boxY, boxWidth, boxHeight, mouseX: startMouseX, mouseY: startMouseY } = resizeStartCanvas;
        let newCanvasX = boxX;
        let newCanvasY = boxY;
        let newCanvasWidth = boxWidth;
        let newCanvasHeight = boxHeight;
        switch (resizeHandle) {
          case 'nw':
            newCanvasWidth = Math.max(minBoxWidth * baseScale * zoomLevel, boxWidth + (startMouseX - mouseX));
            newCanvasHeight = Math.max(minBoxHeight * baseScale * zoomLevel, boxHeight + (startMouseY - mouseY));
            newCanvasX = boxX + (boxWidth - newCanvasWidth);
            newCanvasY = boxY + (boxHeight - newCanvasHeight);
            break;
          case 'ne':
            newCanvasWidth = Math.max(minBoxWidth * baseScale * zoomLevel, boxWidth + (mouseX - startMouseX));
            newCanvasHeight = Math.max(minBoxHeight * baseScale * zoomLevel, boxHeight + (startMouseY - mouseY));
            newCanvasY = boxY + (boxHeight - newCanvasHeight);
            break;
          case 'sw':
            newCanvasWidth = Math.max(minBoxWidth * baseScale * zoomLevel, boxWidth + (startMouseX - mouseX));
            newCanvasHeight = Math.max(minBoxHeight * baseScale * zoomLevel, boxHeight + (mouseY - startMouseY));
            newCanvasX = boxX + (boxWidth - newCanvasWidth);
            break;
          case 'se':
            newCanvasWidth = Math.max(minBoxWidth * baseScale * zoomLevel, boxWidth + (mouseX - startMouseX));
            newCanvasHeight = Math.max(minBoxHeight * baseScale * zoomLevel, boxHeight + (mouseY - startMouseY));
            break;
        }
        // Snap to pixel grid
        newCanvasX = Math.round(newCanvasX);
        newCanvasY = Math.round(newCanvasY);
        newCanvasWidth = Math.round(newCanvasWidth);
        newCanvasHeight = Math.round(newCanvasHeight);
        // Convert to PDF coordinates
        const pdfCoords = convertViewerToPdfCoordinates(newCanvasX, newCanvasY, newCanvasWidth, newCanvasHeight);
        // Constrain to PDF bounds
        const canvas = canvasRef.current;
        const pdfWidth = canvas ? canvas.width / (baseScale * zoomLevel) : 0;
        const pdfHeight = canvas ? canvas.height / (baseScale * zoomLevel) : 0;
        let newX = Math.max(0, Math.min(pdfCoords.x, pdfWidth - pdfCoords.width));
        let newY = Math.max(0, Math.min(pdfCoords.y, pdfHeight - pdfCoords.height));
        let newWidth = Math.min(pdfCoords.width, pdfWidth - newX);
        let newHeight = Math.min(pdfCoords.height, pdfHeight - newY);
        return { ...box, x: newX, y: newY, width: newWidth, height: newHeight };
      }
      return box;
    }));
  };

  // On drag/resize end, clear the drag/resize state
  const handleMouseUp = (event: React.MouseEvent<HTMLDivElement>) => {
    if (isResizing) {
      event.preventDefault();
      event.stopPropagation();
    }
    setIsDragging(false);
    setIsResizing(false);
    setResizeHandle(null);
    setDragStart(null);
    setResizeStartCanvas(null);
  };

  // Keyboard shortcuts and resize handler - only run when mounted and document is available
  useEffect(() => {
    if (!mountedRef.current || typeof window === 'undefined') return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedBoxId) {
          removeSignatureBox(selectedBoxId);
        }
      }
      if (event.key === 'Escape') {
        setSelectedBoxId(null);
        setSignatureBoxes(prev => prev.map(box => ({ ...box, isSelected: false })));
      }
    };

    const handleResize = () => {
      // Re-render current page when window resizes to adjust PDF size
      if (pdfUrl && currentPage) {
        const loadPDF = async () => {
          try {
            const pdfjsLib = await import('pdfjs-dist');
            const loadingTask = pdfjsLib.getDocument(pdfUrl);
            const pdf = await loadingTask.promise;
            await renderPage(pdf, currentPage);
          } catch (error) {
            console.error('Error re-rendering PDF on resize:', error);
          }
        };
        loadPDF();
      }
    };

    const handleWheel = (event: WheelEvent) => {
      // Zoom with Ctrl+Wheel
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const delta = event.deltaY > 0 ? -0.1 : 0.1;
        const newZoom = Math.max(0.5, Math.min(3.0, zoomLevel + delta));
        handleZoomChange(newZoom);
      }
    };

    // Global mouse up handler to ensure resizing/dragging stops even if mouse leaves the container
    const handleGlobalMouseUp = () => {
      if (isResizing || isDragging) {
        setIsDragging(false);
        setIsResizing(false);
        setResizeHandle(null);
      }
    };

    try {
      if (document && typeof document.addEventListener === 'function') {
        document.addEventListener('keydown', handleKeyDown);
        document.addEventListener('mouseup', handleGlobalMouseUp);
        window.addEventListener('resize', handleResize);
        window.addEventListener('wheel', handleWheel, { passive: false });
        return () => {
          if (document && typeof document.removeEventListener === 'function') {
            document.removeEventListener('keydown', handleKeyDown);
            document.removeEventListener('mouseup', handleGlobalMouseUp);
          }
          if (window && typeof window.removeEventListener === 'function') {
            window.removeEventListener('resize', handleResize);
            window.removeEventListener('wheel', handleWheel);
          }
        };
      }
    } catch (error) {
      console.warn('Could not add event listeners:', error);
    }
  }, [selectedBoxId, pdfUrl, currentPage, isResizing, isDragging]);

  const updateSelectedBoxLabel = (newLabel: string) => {
    setSignatureBoxes(prev => prev.map(box => 
      box.id === selectedBoxId ? { ...box, fieldLabel: newLabel } : box
    ));
  };

  const handleSendRequest = async () => {
    if (!selectedReceiver) {
      toast.error('Please select at least one recipient');
      return;
    }

    if (signatureBoxes.length === 0) {
      toast.error('Please add at least one signature field');
      return;
    }

    if (message.length > 300) {
      toast.error('Message is too long');
      return;
    }

    setIsSending(true);

    try {
      const expiresDate = new Date();
      expiresDate.setDate(expiresDate.getDate() + parseInt(expiresIn));

      // Use the same function as the dialog to ensure message bubbles are sent
      await createSignatureRequest(user.id, {
        document_id: documentId!,
        receiver_id: selectedReceiver,
        message: message || undefined,
        expires_at: expiresDate.toISOString(),
        positions: signatureBoxes.map(box => {
          // The signature boxes are already stored in PDF coordinates
          return {
            page_number: box.pageNumber,
            x_position: Math.round(box.x),
            y_position: Math.round(box.y),
            width: Math.round(box.width),
            height: Math.round(box.height),
            field_type: box.fieldType,
            field_label: box.fieldLabel,
            required: box.required,
            scale: baseScale, // Store the scale used for coordinate conversion
            original_pdf_width: originalPdfDimensions?.width || 0,
            original_pdf_height: originalPdfDimensions?.height || 0
          };
        })
      });

      toast.success('Signature request sent successfully');
      router.push('/dashboard/my-vault');
    } catch (error) {
      console.error('Error sending signature request:', error);
      toast.error('Failed to send signature request');
    } finally {
      setIsSending(false);
    }
  };

  if (isLoading) {
    return (
      <div className="container mx-auto p-6">
        <div className="flex items-center justify-center h-64">
          <div className="text-muted-foreground">Loading...</div>
        </div>
      </div>
    );
  }

  if (!document) {
    return (
      <div className="container mx-auto p-6">
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <div className="text-muted-foreground mb-4">Document not found</div>
            <Button onClick={() => router.push('/dashboard/my-vault')}>
              Back to Vault
            </Button>
        </div>
      </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header Section */}
      <div className="flex flex-col space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between space-y-4 sm:space-y-0">
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-primary/10 rounded-lg">
              <Signature className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Request Signature</h1>
              <p className="text-sm text-muted-foreground">Add signature fields and send to recipient</p>
            </div>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => router.push('/dashboard/my-vault')}
              className="gap-2"
          >
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden sm:inline">Back to Vault</span>
              <span className="sm:hidden">Back</span>
          </Button>
          </div>
        </div>
      </div>

      {/* Recipients and Message Section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Recipients */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Recipients</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2">
              <div className="relative">
                <Search className="absolute left-2 top-2.5 w-4 h-4 text-muted-foreground" />
                <Input
                  aria-label="Search recipients"
                  className="pl-8"
                  placeholder="Search by name..."
                  value={recipientSearch}
                  onChange={e => setRecipientSearch(e.target.value)}
                />
              </div>
              <ScrollArea className="h-40 border rounded-md p-2 bg-background">
                {connections.length === 0 ? (
                  <div className="text-center text-muted-foreground py-8">
                    <Users className="w-8 h-8 mx-auto mb-2" />
                    <p>No connections found</p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {connections
                      .filter((connection) => {
                        if (!recipientSearch) return true;
                        return connection.full_name?.toLowerCase().includes(recipientSearch.toLowerCase());
                      })
                      .map((connection) => (
                        <div
                          key={connection.id}
                          className={`flex items-center gap-2 p-2 rounded-md hover:bg-muted cursor-pointer ${selectedReceiver === connection.id ? 'bg-primary/10' : ''}`}
                          onClick={() => setSelectedReceiver(connection.id)}
                        >
                          <input
                            type="radio"
                            checked={selectedReceiver === connection.id}
                            onChange={() => setSelectedReceiver(connection.id)}
                            className="rounded"
                          />
                          <Avatar className="w-7 h-7">
                            <AvatarImage src={connection.avatar_url || undefined} />
                            <AvatarFallback>
                              {connection.full_name?.charAt(0) || 'U'}
                            </AvatarFallback>
                          </Avatar>
                          <span className="font-medium text-sm truncate">{connection.full_name || 'Unknown User'}</span>
                        </div>
                      ))}
                  </div>
                )}
              </ScrollArea>
            </div>
          </CardContent>
        </Card>

        {/* Message */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Message (Optional)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Character count</span>
                <span className={`text-xs ${message.length > 300 ? 'text-destructive' : 'text-muted-foreground'}`}>{message.length}/300</span>
              </div>
              <Textarea
                id="message"
                aria-label="Message"
                placeholder="Add a personal message to your signature request..."
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={3}
                maxLength={310}
              />
            </div>
            
            {/* Expiration */}
            <div className="pt-4 border-t">
              <div className="flex items-center gap-2">
                <Label htmlFor="expires" className="whitespace-nowrap">Expires in</Label>
                <Select value={expiresIn} onValueChange={setExpiresIn}>
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1 day</SelectItem>
                    <SelectItem value="3">3 days</SelectItem>
                    <SelectItem value="7">1 week</SelectItem>
                    <SelectItem value="14">2 weeks</SelectItem>
                    <SelectItem value="30">1 month</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* PDF Viewer */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5" />
                {document.filename}
              </CardTitle>
              <CardDescription>
                Click on the PDF to add signature fields
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* PDF Controls */}
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handlePageChange(currentPage - 1)}
                    disabled={currentPage <= 1}
                  >
                    Previous
                  </Button>
                  <span className="text-sm">
                    Page {currentPage} of {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handlePageChange(currentPage + 1)}
                    disabled={currentPage >= totalPages}
                  >
                    Next
                  </Button>
                  {signatureBoxes.find(box => box.pageNumber === currentPage) && (
                    <Badge variant="secondary" className="ml-2">
                      ✓ Signature Added
                    </Badge>
                  )}
                </div>
              </div>
                      
              {/* PDF Canvas */}
                <div 
                  ref={pdfContainerRef}
                  className={`border rounded-lg overflow-auto relative flex justify-center items-start ${
                    isResizing ? 'bg-blue-50 border-blue-300' : 
                    isDragging ? 'bg-green-50 border-green-300' : 'bg-gray-50'
                  }`}
                  style={{ maxHeight: '600px', minHeight: '400px' }}
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                >
                  {isResizing && (
                    <div className="absolute top-2 left-1/2 transform -translate-x-1/2 z-30 bg-blue-600 text-white px-3 py-1 rounded-md text-sm font-medium shadow-lg">
                      🔄 Resizing from {resizeHandle?.toUpperCase()} corner - Drag to resize box
                          </div>
                  )}
                  
                  {isDragging && (
                    <div className="absolute top-2 left-1/2 transform -translate-x-1/2 z-30 bg-green-600 text-white px-3 py-1 rounded-md text-sm font-medium shadow-lg">
                      🖱️ Dragging box - Move mouse to reposition
                        </div>
                      )}
                      

                  {!pdfUrl ? (
                    <div className="flex items-center justify-center h-full">
                      <div className="text-center text-muted-foreground">
                        <FileText className="w-12 h-12 mx-auto mb-4 opacity-50" />
                        <p>Loading PDF...</p>
                        </div>
                    </div>
                  ) : (
                    <canvas
                      ref={canvasRef}
                      onClick={handleCanvasClick}
                      className={`${
                        isResizing 
                          ? resizeHandle === 'nw' || resizeHandle === 'se' 
                            ? 'cursor-nw-resize' 
                            : 'cursor-ne-resize'
                          : 'cursor-crosshair'
                      }`}
                      style={{ display: 'block', maxWidth: '100%', height: 'auto' }}
                    />
                  )}
                
                {/* Signature Boxes Overlay */}
                {signatureBoxes
                  .filter(box => box.pageNumber === currentPage)
                  .map(box => {
                    // Convert PDF coordinates to viewer coordinates for display
                    const viewerCoords = convertPdfToViewerCoordinates(box.x, box.y, box.width, box.height);
                    
                    return (
                      <div
                        key={box.id}
                        className={`absolute border-2 rounded ${
                          box.isSelected || selectedBoxId === box.id
                            ? isDragging 
                              ? 'border-green-500 bg-green-100 bg-opacity-30 shadow-lg'
                              : isResizing
                              ? 'border-orange-500 bg-orange-100 bg-opacity-30 shadow-lg'
                              : 'border-blue-500 bg-blue-100 bg-opacity-30'
                            : 'border-gray-400 bg-gray-100 bg-opacity-20'
                        }`}
                        style={{
                          left: viewerCoords.x,
                          top: viewerCoords.y,
                          width: viewerCoords.width,
                          height: viewerCoords.height,
                          pointerEvents: 'auto',
                          cursor: 'move'
                        }}
                        onMouseDown={handleBoxDragStart(box.id)}
                      >
                        <div className="text-xs font-medium text-gray-700 p-1">
                          {box.fieldLabel}
                        </div>
                        
                        {/* Signature preview area */}
                        <div className="absolute inset-0 pointer-events-none">
                          <div className="absolute top-2 left-2 right-2 bottom-16 border border-dashed border-gray-300 rounded bg-white bg-opacity-50 flex items-center justify-center">
                            <span className="text-xs text-gray-500">Signature Area</span>
                          </div>
                          <div className="absolute bottom-2 left-2 right-2 h-12 border border-dashed border-gray-300 rounded bg-gray-50 bg-opacity-50 flex items-center justify-center">
                            <span className="text-xs text-gray-500">Metadata Area</span>
                          </div>
                        </div>
                        
                        {/* Delete Button */}
                        {(box.isSelected || selectedBoxId === box.id) && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              removeSignatureBox(box.id);
                            }}
                            className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 text-white rounded-full text-xs flex items-center justify-center hover:bg-red-600"
                            style={{ pointerEvents: 'auto', zIndex: 30 }}
                          >
                            ×
                          </button>
                        )}
                        
                        {/* Resize Handles */}
                        {(box.isSelected || selectedBoxId === box.id) && (
                          <>
                            {/* Top-left */}
                            <div
                              className={`absolute w-8 h-8 bg-blue-600 border-2 border-white rounded-full cursor-nw-resize shadow-lg transition-all hover:bg-blue-700 ${
                                hoveredHandle === 'nw' || (isResizing && resizeHandle === 'nw') ? 'bg-blue-700 scale-110' : ''
                              }`}
                            style={{
                                left: -4,
                                top: -4,
                                pointerEvents: 'auto',
                                zIndex: 20
                              }}
                              onMouseDown={handleResizeStart('nw', box.id)}
                              title="Resize from top-left"
                            />
                            {/* Top-right */}
                            <div
                              className={`absolute w-8 h-8 bg-blue-600 border-2 border-white rounded-full cursor-ne-resize shadow-lg transition-all hover:bg-blue-700 ${
                                hoveredHandle === 'ne' || (isResizing && resizeHandle === 'ne') ? 'bg-blue-700 scale-110' : ''
                              }`}
                              style={{
                                right: -4,
                                top: -4,
                                pointerEvents: 'auto',
                                zIndex: 20
                              }}
                              onMouseDown={handleResizeStart('ne', box.id)}
                              title="Resize from top-right"
                            />
                            {/* Bottom-left */}
                            <div
                              className={`absolute w-8 h-8 bg-blue-600 border-2 border-white rounded-full cursor-sw-resize shadow-lg transition-all hover:bg-blue-700 ${
                                hoveredHandle === 'sw' || (isResizing && resizeHandle === 'sw') ? 'bg-blue-700 scale-110' : ''
                              }`}
                              style={{
                                left: -4,
                                bottom: -4,
                                pointerEvents: 'auto',
                                zIndex: 20
                              }}
                              onMouseDown={handleResizeStart('sw', box.id)}
                              title="Resize from bottom-left"
                            />
                            {/* Bottom-right */}
                            <div
                              className={`absolute w-8 h-8 bg-blue-600 border-2 border-white rounded-full cursor-se-resize shadow-lg transition-all hover:bg-blue-700 ${
                                hoveredHandle === 'se' || (isResizing && resizeHandle === 'se') ? 'bg-blue-700 scale-110' : ''
                              }`}
                              style={{
                                right: -4,
                                bottom: -4,
                                pointerEvents: 'auto',
                                zIndex: 20
                              }}
                              onMouseDown={handleResizeStart('se', box.id)}
                              title="Resize from bottom-right"
                            />
                          </>
                    )}
                      </div>
                    );
                  })}
              </div>


            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Add Signature Field */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Add Signature Field</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="text-sm text-muted-foreground space-y-1">
                <div>• Click on the PDF to place signature fields</div>
                <div>• One signature per page maximum</div>
                <div>• Drag boxes to reposition them</div>
                <div>• Drag corners to resize boxes</div>
                <div>• Use zoom controls to adjust view</div>
                <div>• Click boxes to select and edit</div>
                <div>• Minimum size: 50×50px</div>
                <div className="mt-2 p-2 bg-primary/5 border border-primary/10 rounded text-xs">
                  <div className="font-medium text-primary">Signature Layout:</div>
                  <div className="text-primary/80">• Top area: Signature image</div>
                  <div className="text-primary/80">• Bottom area: Metadata (name, date, ID)</div>
                </div>
                {isResizing && (
                  <div className="text-primary font-medium">🔄 Resizing active - drag to resize</div>
                )}
                {isDragging && (
                  <div className="text-primary font-medium">🖱️ Dragging active - move to reposition</div>
                )}
              </div>
            </CardContent>
          </Card>



          {/* Signature Fields Summary */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Signature Fields</CardTitle>
              <CardDescription>
                {signatureBoxes.length} field(s) added • One per page • Click to select and edit
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-32">
                <div className="space-y-2">
                  {signatureBoxes.map((box) => (
                    <div 
                      key={box.id} 
                      className={`flex items-center justify-between p-2 rounded cursor-pointer transition-colors ${
                        selectedBoxId === box.id 
                          ? 'bg-primary/10 border border-primary/20' 
                          : 'bg-muted hover:bg-muted/80'
                      }`}
                      onClick={() => {
                        setSelectedBoxId(box.id);
                        setSignatureBoxes(prev => prev.map(b => ({ ...b, isSelected: b.id === box.id })));
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">
                          {box.fieldType}
                        </Badge>
                        <span className="text-sm font-medium">{box.fieldLabel}</span>
                        <span className="text-xs text-muted-foreground">
                          (Page {box.pageNumber})
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeSignatureBox(box.id);
                          }}
                        >
                          <Trash2 className="h-3 w-3" />
                      </Button>
                      </div>
                    </div>
                  ))}
                  {signatureBoxes.length === 0 && (
                    <div className="text-center text-muted-foreground py-4">
                      <FileText className="w-6 h-6 mx-auto mb-2 opacity-50" />
                      <p className="text-sm">No signature fields added yet</p>
                      <p className="text-xs">Click on the PDF to add signature fields</p>
                </div>
              )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          {/* Send Button */}
          <Button
            onClick={handleSendRequest}
            disabled={isSending || !selectedReceiver || signatureBoxes.length === 0 || message.length > 300}
            className="w-full"
          >
            {isSending && <span className="animate-spin mr-2 w-4 h-4 border-2 border-white border-t-transparent rounded-full inline-block align-middle" />}
            {isSending ? 'Sending...' : 'Send Signature Request'}
          </Button>
        </div>
      </div>
    </div>
  );
} 