document.addEventListener('DOMContentLoaded', () => {
  // Get DOM elements
  const form = document.getElementById('transcriptionForm');
  const urlInput = document.getElementById('videoUrl');
  const submitBtn = document.getElementById('transcribeBtn');
  const loadingSpinner = document.getElementById('loadingSpinner');
  const buttonText = document.getElementById('buttonText');
  const transcriptionsContainer = document.getElementById('transcriptionsContainer');
  const downloadAllBtn = document.getElementById('downloadAllBtn');
  const downloadAllContainer = document.getElementById('downloadAllContainer');
  const errorAlert = document.getElementById('errorAlert');
  const errorMessage = document.getElementById('errorMessage');

  // Form submission handler
  form.addEventListener('submit', function(e) {
    e.preventDefault();
    
    // Get URLs from input
    const urls = urlInput.value.trim().split('\n').filter(url => url.trim() !== '');
    
    if (urls.length === 0) {
      showError('Please enter at least one URL');
      return;
    }
    
    // Show loading state
    setLoading(true);
    
    // Hide previous results and errors
    hideResult();
    hideError();
    
    // Send request to server
    fetch('/transcribe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ urls })
    })
    .then(response => {
      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }
      return response.json();
    })
    .then(data => {
      // Hide loading
      setLoading(false);
      
      // Display results
      displayResults(data);
    })
    .catch(error => {
      console.error('Error:', error);
      setLoading(false);
      showError('Error: ' + error.message);
    });
  });
  
  // Function to display results
  function displayResults(data) {
    // Очищаем контейнер с транскрипциями
    transcriptionsContainer.innerHTML = '';
    
    // Показываем кнопку скачивания всех транскрипций, если есть результаты
    if (data.results && data.results.length > 0) {
      downloadAllContainer.classList.remove('d-none');
    } else {
      downloadAllContainer.classList.add('d-none');
    }
    
    // Создаем карточку для каждой транскрипции
    data.results.forEach((result, index) => {
      // Создаем основную карточку
      const card = document.createElement('div');
      card.className = 'card shadow-lg mb-4';
      
      // Создаем заголовок карточки с белым текстом
      const cardHeader = document.createElement('div');
      cardHeader.className = 'card-header bg-primary text-white custom-card-header';
      
      // Добавляем название видео и URL
      const titleRow = document.createElement('div');
      titleRow.className = 'd-flex justify-content-between align-items-center';
      
      const title = document.createElement('h5');
      title.className = 'mb-0';
      title.textContent = result.title || `Video ${index + 1}`;
      
      // Создаем кликабельную ссылку вместо обычного текста
      const urlBadge = document.createElement('a');
      urlBadge.className = 'badge bg-secondary text-decoration-none';
      urlBadge.href = result.url;
      urlBadge.target = '_blank'; // Открывать в новой вкладке
      urlBadge.rel = 'noopener noreferrer'; // Безопасность для внешних ссылок
      urlBadge.textContent = result.url || 'Ссылка на источник';
      urlBadge.style.pointerEvents = 'auto'; // Явно разрешаем события указателя
      urlBadge.style.cursor = 'pointer'; // Устанавливаем курсор как для ссылки
      urlBadge.addEventListener('click', (e) => {
        // Предотвращаем всплытие события, чтобы оно не перехватывалось родительскими элементами
        e.stopPropagation();
      });
      
      titleRow.appendChild(title);
      titleRow.appendChild(urlBadge);
      cardHeader.appendChild(titleRow);
      
      // Создаем тело карточки
      const cardBody = document.createElement('div');
      cardBody.className = 'card-body';
      
      // Добавляем кнопки управления
      const buttonGroup = document.createElement('div');
      buttonGroup.className = 'd-flex justify-content-end mb-3';
      
      // Кнопка копирования
      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn btn-sm btn-outline-secondary me-2';
      copyBtn.innerHTML = '<i class="bi bi-clipboard"></i> Copy';
      copyBtn.addEventListener('click', function() {
        navigator.clipboard.writeText(result.transcription)
          .then(() => {
            const originalText = copyBtn.innerHTML;
            copyBtn.innerHTML = '<i class="bi bi-check"></i> Copied';
            
            setTimeout(() => {
              copyBtn.innerHTML = originalText;
            }, 2000);
          })
          .catch(err => {
            console.error('Error copying text:', err);
            showError('Failed to copy text');
          });
      });
      
      // Кнопка скачивания
      const downloadBtn = document.createElement('button');
      downloadBtn.className = 'btn btn-sm btn-outline-primary';
      downloadBtn.innerHTML = '<i class="bi bi-download"></i> Download TXT';
      downloadBtn.addEventListener('click', function() {
        const blob = new Blob([result.transcription], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${result.title || 'transcription'}.txt`;
        document.body.appendChild(a);
        a.click();
        
        // Cleanup
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 100);
      });
      
      buttonGroup.appendChild(copyBtn);
      buttonGroup.appendChild(downloadBtn);
      
      // Добавляем текст транскрипции
      const transcriptionText = document.createElement('div');
      transcriptionText.className = 'p-3 bg-light rounded transcription-box';
      transcriptionText.style.whiteSpace = 'pre-wrap';
      transcriptionText.textContent = result.transcription || 'No transcription found';
      
      // Собираем всё вместе
      cardBody.appendChild(buttonGroup);
      cardBody.appendChild(transcriptionText);
      
      card.appendChild(cardHeader);
      card.appendChild(cardBody);
      
      // Добавляем карточку в контейнер
      transcriptionsContainer.appendChild(card);
    });
    
    // If there are errors, show them too
    if (data.errors && data.errors.length > 0) {
      const errorMessages = data.errors.map(err => `URL: ${err.url} - Error: ${err.error}`).join('\n');
      showError(`Some URLs could not be processed:\n${errorMessages}`);
    }
    
    // Scroll to results
    if (transcriptionsContainer.firstChild) {
      transcriptionsContainer.firstChild.scrollIntoView({ behavior: 'smooth' });
    }
  }
  
  // Loading state function
  function setLoading(isLoading) {
    if (isLoading) {
      submitBtn.disabled = true;
      loadingSpinner.classList.remove('d-none');
      buttonText.textContent = 'Processing...';
    } else {
      submitBtn.disabled = false;
      loadingSpinner.classList.add('d-none');
      buttonText.textContent = 'Create Transcriptions';
    }
  }
  
  // Result hide function
  function hideResult() {
    transcriptionsContainer.innerHTML = '';
    downloadAllContainer.classList.add('d-none');
  }
  
  // Error display function
  function showError(message) {
    errorAlert.classList.remove('d-none');
    errorMessage.textContent = message;
  }
  
  // Error hide function
  function hideError() {
    errorAlert.classList.add('d-none');
    errorMessage.textContent = '';
  }
  
  // Initialize
  document.addEventListener('DOMContentLoaded', function() {
    // Hide loading spinner on initial load
    loadingSpinner.classList.add('d-none');
    
    // Hide download all button initially
    downloadAllContainer.classList.add('d-none');
  });
  
  // Download all transcriptions button handler
  downloadAllBtn.addEventListener('click', function() {
    // Получаем все транскрипции из контейнера
    const transcriptionCards = document.querySelectorAll('#transcriptionsContainer .card');
    
    if (transcriptionCards.length === 0) {
      showError('No transcriptions to download');
      return;
    }
    
    // Создаем небольшую задержку между скачиваниями, чтобы браузер успевал обрабатывать каждый файл
    transcriptionCards.forEach((card, index) => {
      const title = card.querySelector('.card-header h5').textContent;
      const transcription = card.querySelector('.bg-light').textContent;
      
      // Используем setTimeout для создания задержки между скачиваниями
      setTimeout(() => {
        // Создаем файл и скачиваем его
        const blob = new Blob([transcription], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${title || 'transcription'}.txt`;
        document.body.appendChild(a);
        a.click();
        
        // Cleanup
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 100);
      }, index * 300); // 300 мс задержки между скачиваниями
    });
  });
});
